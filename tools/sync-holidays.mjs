#!/usr/bin/env node
/**
 * 生成 src/holidays.data.js：内置法定节假日表（离线，运行时零网络请求）。
 *
 * 数据来源：NateScarlet/holiday-cn（MIT），每年一个 JSON，papers 字段可溯源到
 * 国务院办公厅公告。只取 isOffDay === true 的日期——调休上班日（isOffDay === false）
 * 不参与计价：DeepSeek 官方口径是“周一至周五 UTC 01:00–04:00 / 06:00–10:00 为高峰”，
 * 周末整天低谷，补班周六不构成高峰（需求文档 §4.5）。
 *
 * 用法：
 *   node tools/sync-holidays.mjs                 # 默认同步 2024–2027
 *   node tools/sync-holidays.mjs 2024 2028       # 指定年份范围
 *
 * 只在开发机与 CI 运行。产物随包发布，不联网。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUTPUT = path.join(ROOT, 'src', 'holidays.data.js');
const BASE_URL = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master';

const DEFAULT_FIRST_YEAR = 2024;
const DEFAULT_LAST_YEAR = 2027;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseYears(argv) {
  const numbers = argv.map(value => Number(value)).filter(value => Number.isInteger(value));
  const first = numbers[0] || DEFAULT_FIRST_YEAR;
  const last = numbers[1] || DEFAULT_LAST_YEAR;
  if (last < first) throw new Error(`年份范围非法：${first}–${last}`);
  const years = [];
  for (let year = first; year <= last; year += 1) years.push(year);
  return years;
}

async function fetchYear(year) {
  const url = `${BASE_URL}/${year}.json`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`拉取 ${year} 失败：HTTP ${response.status} ${url}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.days)) throw new Error(`${year} 返回结构异常：缺少 days 数组`);
  return { year, url, data };
}

async function main() {
  const years = parseYears(process.argv.slice(2));
  const offDays = new Set();
  const papers = [];
  const perYear = [];

  for (const year of years) {
    const { data, url } = await fetchYear(year);
    let counted = 0;
    for (const day of data.days) {
      if (!day || day.isOffDay !== true) continue;
      const value = String(day.date || '').trim();
      // 文件标题年份与日期年份可能不一致（12 月假期可能落在次年文件里），
      // 因此按日期去重，不按年份分桶存放。
      if (!DAY_RE.test(value)) continue;
      if (offDays.has(value)) continue;
      offDays.add(value);
      counted += 1;
    }
    for (const paper of data.papers || []) {
      // 上游 papers 目前是 URL 字符串数组，也兼容 {url,title} 对象形式。
      if (typeof paper === 'string' && paper) papers.push({ year, url: paper, title: '' });
      else if (paper && paper.url) papers.push({ year, url: paper.url, title: paper.title || '' });
    }
    perYear.push({ year, days: counted, source: url });
  }

  const days = Array.from(offDays).sort();
  const header = [
    "'use strict';",
    '',
    '// 本文件由 tools/sync-holidays.mjs 自动生成，请勿手工编辑。',
    '// 数据来源：NateScarlet/holiday-cn（MIT License），原始公告见 papers 字段。',
    '// 只包含 isOffDay === true 的日期；调休上班日不参与计价（见 docs/0.2.0 §4.5）。',
    `// 覆盖年份：${years[0]}–${years[years.length - 1]}；生成时间：${new Date().toISOString()}`,
    '',
    'const HOLIDAY_YEARS = ' + JSON.stringify(years) + ';',
    '',
    'const HOLIDAY_DAYS = [',
    ...days.map(value => `  '${value}'`).map((line, index) => (index === days.length - 1 ? line : `${line},`)),
    '];',
    '',
    'const HOLIDAY_PAPERS = ' + JSON.stringify(papers, null, 2) + ';',
    '',
    'module.exports = { HOLIDAY_YEARS, HOLIDAY_DAYS, HOLIDAY_PAPERS };',
    ''
  ];

  fs.writeFileSync(OUTPUT, header.join('\n'), 'utf8');
  console.log(`已生成 ${path.relative(ROOT, OUTPUT)}：${days.length} 天，覆盖 ${years[0]}–${years[years.length - 1]}`);
  for (const item of perYear) console.log(`  ${item.year}: ${item.days} 天  ${item.source}`);
  console.log(`公告链接：${papers.length} 条`);
}

main().catch(error => {
  console.error(`同步失败：${error.message}`);
  process.exitCode = 1;
});
