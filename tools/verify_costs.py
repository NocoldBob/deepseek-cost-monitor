#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

SHANGHAI = timezone(timedelta(hours=8))
ASSISTANT_MARKERS = ('"type":"assistant"', '"type": "assistant"')

DEFAULT_HOLIDAYS = [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
]

RATE_CARDS = {
    'deepseek-flash': {
        'CNY': {'cacheHit': 0.04, 'cacheMiss': 2.0, 'output': 8.0},
        'USD': {'cacheHit': 0.006, 'cacheMiss': 0.3, 'output': 1.2},
    },
    'deepseek-v4-pro': {
        'CNY': {'cacheHit': 0.3, 'cacheMiss': 9.0, 'output': 27.0},
        'USD': {'cacheHit': 0.044, 'cacheMiss': 1.32, 'output': 3.96},
    },
}

FALLBACK_MODEL = 'deepseek-flash'


def normalize_model(raw):
    return re.sub(r'\[[^\]]*\]\s*$', '', str(raw or '').strip().lower()).strip()


def included_model(model, prefixes):
    normalized = normalize_model(model)
    if not normalized or normalized == '<synthetic>':
        return False
    for prefix in prefixes:
        value = str(prefix or '').strip().lower()
        if value and normalized.startswith(value):
            return True
    return False


def parse_ts(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        match = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$', text)
        if not match:
            return None
        fraction = (match.group(2) or '')[:6].ljust(6, '0')
        rebuilt = match.group(1) + (('.' + fraction) if match.group(2) else '') + match.group(3)
        try:
            parsed = datetime.fromisoformat(rebuilt)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(round(parsed.timestamp() * 1000))


def to_count(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if number != number or number <= 0:
        return 0
    return int(number)


def day_info(now_ms):
    local = datetime.fromtimestamp(now_ms / 1000, SHANGHAI)
    start = datetime(local.year, local.month, local.day, tzinfo=SHANGHAI)
    key = start.strftime('%Y-%m-%d')
    weekday = '一二三四五六日'[start.weekday()]
    return key, int(start.timestamp() * 1000), int((start + timedelta(days=1)).timestamp() * 1000), \
        f'{start.year}年{start.month}月{start.day}日 周{weekday}'


def is_peak(ts_ms, holidays):
    local = datetime.fromtimestamp(ts_ms / 1000, SHANGHAI)
    if local.weekday() >= 5:
        return False
    if local.strftime('%Y-%m-%d') in holidays:
        return False
    minutes = local.hour * 60 + local.minute
    return (540 <= minutes < 720) or (840 <= minutes < 1080)


def market_mode(now_ms, holidays):
    local = datetime.fromtimestamp(now_ms / 1000, SHANGHAI)
    holiday = local.strftime('%Y-%m-%d') in holidays
    peak = is_peak(now_ms, holidays)
    return {'mode': 'peak' if peak else 'offpeak', 'label': '高峰' if peak else '低谷', 'isHoliday': holiday}


def resolve_rates(model, currency, overrides):
    normalized = normalize_model(model)
    override = overrides.get(normalized)
    if isinstance(override, dict) and isinstance(override.get(currency), dict):
        return override[currency], False, True
    if normalized in RATE_CARDS:
        return RATE_CARDS[normalized][currency], False, False
    for known in RATE_CARDS:
        if normalized.startswith(known):
            return RATE_CARDS[known][currency], True, False
    return RATE_CARDS[FALLBACK_MODEL][currency], True, False


def request_cost(record, rates, holidays):
    base = (
        record['inputTokens'] * rates['cacheMiss']
        + record['cacheReadTokens'] * rates['cacheHit']
        + record['outputTokens'] * rates['output']
    ) / 1000000.0
    return base if is_peak(record['timestampMs'], holidays) else base * 0.5


def derive_session_id(file_path):
    parts = [part for part in re.split(r'[\\/]', str(file_path or '')) if part]
    for index in range(len(parts) - 1, -1, -1):
        if parts[index].lower() == 'subagents' and index > 0:
            return parts[index - 1]
    base = parts[-1] if parts else 'unknown'
    return re.sub(r'\.jsonl$', '', base, flags=re.IGNORECASE) or 'unknown'


def base_name(value):
    parts = re.split(r'[\\/]', re.sub(r'[\\/]+$', '', str(value or '')))
    return parts[-1] if parts and parts[-1] else '未知项目'


def better_snapshot(candidate, previous):
    if candidate['outputTokens'] != previous['outputTokens']:
        return candidate['outputTokens'] > previous['outputTokens']
    if candidate['timestampMs'] != previous['timestampMs']:
        return candidate['timestampMs'] > previous['timestampMs']
    return (candidate['inputTokens'] + candidate['cacheReadTokens']) > \
        (previous['inputTokens'] + previous['cacheReadTokens'])


class UsageStore:
    def __init__(self):
        self.records = {}
        self.stats = {'assistantRows': 0, 'accepted': 0, 'skipped': 0, 'duplicates': 0}

    def add(self, row, source_file):
        self.stats['assistantRows'] += 1
        message = row.get('message')
        if not isinstance(message, dict) or not isinstance(message.get('usage'), dict):
            self.stats['skipped'] += 1
            return
        message_id = message.get('id')
        timestamp_ms = parse_ts(row.get('timestamp'))
        model = message.get('model')
        if not isinstance(message_id, str) or not message_id or timestamp_ms is None \
                or not isinstance(model, str) or not model:
            self.stats['skipped'] += 1
            return
        usage = message['usage']
        record = {
            'messageId': message_id,
            'timestampMs': timestamp_ms,
            'model': model,
            'normalizedModel': normalize_model(model),
            'sessionId': row.get('sessionId') if isinstance(row.get('sessionId'), str) and row.get('sessionId')
            else derive_session_id(source_file),
            'cwd': row.get('cwd') if isinstance(row.get('cwd'), str) else None,
            'isSubagent': bool(row.get('isSidechain')) or bool(re.search(r'[\\/]subagents[\\/]', str(source_file), re.I)),
            'inputTokens': to_count(usage.get('input_tokens')),
            'cacheReadTokens': to_count(usage.get('cache_read_input_tokens')),
            'cacheCreationTokens': to_count(usage.get('cache_creation_input_tokens')),
            'outputTokens': to_count(usage.get('output_tokens')),
            'sourceFile': source_file,
        }
        previous = self.records.get(message_id)
        if previous is None:
            self.records[message_id] = record
            self.stats['accepted'] += 1
            return
        self.stats['duplicates'] += 1
        if better_snapshot(record, previous):
            self.records[message_id] = record


def empty_tokens():
    return {'cacheMiss': 0, 'cacheHit': 0, 'cacheCreation': 0, 'output': 0, 'total': 0}


def add_tokens(target, record):
    target['cacheMiss'] += record['inputTokens']
    target['cacheHit'] += record['cacheReadTokens']
    target['cacheCreation'] += record['cacheCreationTokens']
    target['output'] += record['outputTokens']
    target['total'] = target['cacheMiss'] + target['cacheHit'] + target['output']


def build_snapshot(store, scan_info, settings, now_ms):
    day_key, start_ms, end_ms, day_label = day_info(now_ms)
    currency = settings['currency']
    overrides = settings.get('rateOverrides') or {}
    holidays = settings['holidays']
    totals = {'cost': 0.0, 'requests': 0, 'tokens': empty_tokens()}
    by_model = {}
    by_session = {}
    excluded_models = {}
    unknown_models = []
    unknown_seen = set()
    synthetic_count = 0
    excluded_requests = 0

    for record in store.records.values():
        if record['timestampMs'] < start_ms or record['timestampMs'] >= end_ms:
            continue
        if not settings['includeSubagents'] and record['isSubagent']:
            continue
        if record['model'] == '<synthetic>' or record['normalizedModel'] == '<synthetic>':
            synthetic_count += 1
            continue
        if not included_model(record['normalizedModel'], settings['modelPrefixes']):
            excluded_requests += 1
            key = record['model'] or '(未知)'
            excluded_models[key] = excluded_models.get(key, 0) + 1
            continue

        rates, estimated, custom = resolve_rates(record['normalizedModel'], currency, overrides)
        if estimated and record['normalizedModel'] not in unknown_seen:
            unknown_seen.add(record['normalizedModel'])
            unknown_models.append(record['normalizedModel'])
        cost = request_cost(record, rates, holidays)

        totals['cost'] += cost
        totals['requests'] += 1
        add_tokens(totals['tokens'], record)

        entry = by_model.get(record['normalizedModel'])
        if entry is None:
            entry = {
                'model': record['normalizedModel'], 'requests': 0, 'cost': 0.0,
                'tokens': empty_tokens(), 'estimated': False, 'custom': False,
            }
            by_model[record['normalizedModel']] = entry
        entry['requests'] += 1
        entry['cost'] += cost
        add_tokens(entry['tokens'], record)
        entry['estimated'] = entry['estimated'] or estimated
        entry['custom'] = entry['custom'] or custom

        session_key = record['sessionId'] or 'unknown'
        session = by_session.get(session_key)
        if session is None:
            session = {
                'sessionId': session_key, 'shortId': session_key[:8], 'cwdLabel': '',
                'requests': 0, 'cost': 0.0, 'tokens': empty_tokens(),
                'includesSubagents': False, '_lastTs': 0,
            }
            by_session[session_key] = session
        session['requests'] += 1
        session['cost'] += cost
        add_tokens(session['tokens'], record)
        if record['isSubagent']:
            session['includesSubagents'] = True
        if record['cwd'] and (not session['cwdLabel'] or record['timestampMs'] >= session['_lastTs']):
            session['cwdLabel'] = base_name(record['cwd'])
        if record['timestampMs'] >= session['_lastTs']:
            session['_lastTs'] = record['timestampMs']

    models = sorted(by_model.values(), key=lambda item: (-item['cost'], item['model']))
    sessions = sorted(by_session.values(), key=lambda item: (-item['cost'], item['sessionId']))
    for session in sessions:
        session.pop('_lastTs', None)
        if not session['cwdLabel']:
            session['cwdLabel'] = '未知项目'

    warnings = []
    if unknown_models:
        warnings.append({
            'code': 'unknown-model',
            'message': f"模型 {'、'.join(unknown_models)} 未在价目表中，已按 Flash 价估算。",
        })

    return {
        'schemaVersion': 1,
        'loading': False,
        'error': None,
        'dayKey': day_key,
        'dayLabel': day_label,
        'updatedAtMs': now_ms,
        'currency': currency,
        'currencySymbol': '$' if currency == 'USD' else '¥',
        'market': market_mode(now_ms, holidays),
        'totals': totals,
        'byModel': models,
        'bySession': sessions,
        'excluded': {
            'nonDeepseekRequests': excluded_requests,
            'nonDeepseekModels': list(excluded_models.keys()),
            'nonDeepseekBreakdown': [{'model': key, 'requests': value} for key, value in excluded_models.items()],
            'syntheticRequests': synthetic_count,
        },
        'warnings': warnings,
        'scan': scan_info,
        'store': dict(store.stats),
    }


def run_pricing_assertions():
    holidays = {'2026-10-01'}
    cases = [
        ('工作日10:00高峰', '2026-11-24T10:00:00+08:00', True),
        ('工作日12:00低谷', '2026-11-24T12:00:00+08:00', False),
        ('工作日14:00高峰', '2026-11-24T14:00:00+08:00', True),
        ('工作日18:00低谷', '2026-11-24T18:00:00+08:00', False),
        ('周日低谷', '2026-11-22T10:00:00+08:00', False),
        ('节假日低谷', '2026-10-01T10:00:00+08:00', False),
    ]
    results = []
    for name, iso, expected in cases:
        actual = is_peak(parse_ts(iso), holidays)
        results.append({'name': name, 'ok': actual == expected, 'expected': expected, 'actual': actual})
    before = day_info(parse_ts('2026-11-23T15:59:59Z'))[0]
    after = day_info(parse_ts('2026-11-23T16:00:00Z'))[0]
    results.append({'name': 'UTC日界前', 'ok': before == '2026-11-23', 'expected': '2026-11-23', 'actual': before})
    results.append({'name': 'UTC日界后', 'ok': after == '2026-11-24', 'expected': '2026-11-24', 'actual': after})
    return results


def scan_projects(root):
    paths = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith('.jsonl'):
                paths.append(os.path.join(dirpath, name))
    paths.sort()

    store = UsageStore()
    bytes_read = 0
    assistant_rows = 0
    malformed_lines = 0
    started = datetime.now()

    for file_path in paths:
        try:
            with open(file_path, 'rb') as handle:
                raw = handle.read()
        except OSError:
            continue
        bytes_read += len(raw)
        text = raw.decode('utf-8', errors='replace')
        lines = text.split('\n')
        if lines and lines[-1] == '':
            lines.pop()
        for index, line in enumerate(lines):
            if line.endswith('\r'):
                line = line[:-1]
            if index == 0 and line.startswith('﻿'):
                line = line[1:]
            if not line or not any(marker in line for marker in ASSISTANT_MARKERS):
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                malformed_lines += 1
                continue
            if isinstance(row, dict) and row.get('type') == 'assistant':
                assistant_rows += 1
                store.add(row, file_path)

    duration_ms = int((datetime.now() - started).total_seconds() * 1000)
    scan_info = {
        'files': len(paths),
        'bytesRead': bytes_read,
        'assistantRows': assistant_rows,
        'malformedLines': malformed_lines,
        'durationMs': duration_ms,
        'mode': 'full',
    }
    files = [{'path': path, 'offset': os.path.getsize(path), 'pendingBytes': 0, 'errors': 0} for path in paths]
    return store, scan_info, files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--projects', default=os.path.join(os.path.expanduser('~'), '.claude', 'projects'))
    parser.add_argument('--date', default=None)
    parser.add_argument('--currency', default='CNY', choices=['CNY', 'USD'])
    parser.add_argument('--prefixes', default='deepseek')
    parser.add_argument('--exclude-subagents', action='store_true')
    parser.add_argument('--holidays', default=None)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    if args.date:
        now_ms = parse_ts(args.date + 'T12:00:00+08:00')
        if now_ms is None:
            print(f'无法解析日期：{args.date}', file=sys.stderr)
            return 2
    else:
        now_ms = int(round(datetime.now(timezone.utc).timestamp() * 1000))

    if args.holidays is None:
        holidays = set(DEFAULT_HOLIDAYS)
        holiday_list = list(DEFAULT_HOLIDAYS)
    elif args.holidays == '':
        holidays = set()
        holiday_list = []
    else:
        holiday_list = [item.strip() for item in args.holidays.split(',') if item.strip()]
        holidays = set(holiday_list)

    prefixes = [item.strip().lower() for item in args.prefixes.split(',') if item.strip()]
    settings = {
        'projectsRoot': args.projects,
        'modelPrefixes': prefixes,
        'currency': args.currency,
        'rateOverrides': {},
        'holidays': holidays,
        'includeSubagents': not args.exclude_subagents,
    }

    store, scan_info, files = scan_projects(args.projects)
    snapshot = build_snapshot(store, scan_info, settings, now_ms)
    assertions = run_pricing_assertions()
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        'settings': {
            'projectsRoot': args.projects,
            'modelPrefixes': prefixes,
            'currency': args.currency,
            'includeSubagents': settings['includeSubagents'],
            'holidays': holiday_list,
            'rateOverrides': {},
        },
        'pricingAssertions': assertions,
        'snapshot': snapshot,
        'files': files,
    }

    if not args.json:
        print(f"日期：{snapshot['dayLabel']}（{snapshot['dayKey']}）")
        print(f"金额：{snapshot['currencySymbol']}{snapshot['totals']['cost']:.6f} · 请求 {snapshot['totals']['requests']}")
        print(f"扫描：{scan_info['files']} 个文件，{scan_info['bytesRead']} 字节，assistant 行 {scan_info['assistantRows']}，坏行 {scan_info['malformedLines']}")
        for model in snapshot['byModel']:
            print(f"模型 {model['model']}：{model['requests']} 次 · {snapshot['currencySymbol']}{model['cost']:.6f}")
        for session in snapshot['bySession']:
            print(f"会话 #{session['shortId']} {session['cwdLabel']}：{session['requests']} 次 · {snapshot['currencySymbol']}{session['cost']:.6f}")
        for item in assertions:
            print(f"{'[PASS]' if item['ok'] else '[FAIL]'} {item['name']} expected={item['expected']} actual={item['actual']}")

    print('SELFTEST_JSON ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    return 0 if all(item['ok'] for item in assertions) else 1


if __name__ == '__main__':
    sys.exit(main())
