'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readCleanupPeriodDays, configDirFromEnv } = require('../src/retention');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-retention-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

test('只读读取 cleanupPeriodDays，不修改 settings.json', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 30, env: { TOKEN: 'should-not-leak' } }), 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    const result = readCleanupPeriodDays({ configDir: dir });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.days, 30);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  } finally {
    cleanup(dir);
  }
});

test('settings.json 不存在时不创建文件', () => {
  const dir = tempDir();
  try {
    const result = readCleanupPeriodDays({ configDir: dir });
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.days, null);
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
  } finally {
    cleanup(dir);
  }
});

test('JSON 损坏或字段非法时静默跳过', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    let result = readCleanupPeriodDays({ configDir: dir });
    assert.strictEqual(result.found, false);
    assert.ok(result.error);

    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: -1 }), 'utf8');
    result = readCleanupPeriodDays({ configDir: dir });
    assert.strictEqual(result.found, false);

    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: '45' }), 'utf8');
    result = readCleanupPeriodDays({ configDir: dir });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.days, 45);
  } finally {
    cleanup(dir);
  }
});

test('CLAUDE_CONFIG_DIR 优先于默认目录', () => {
  const dir = tempDir();
  try {
    assert.strictEqual(configDirFromEnv({ CLAUDE_CONFIG_DIR: dir }), path.resolve(dir));
    const result = readCleanupPeriodDays({ env: { CLAUDE_CONFIG_DIR: dir } });
    assert.strictEqual(result.path, path.join(path.resolve(dir), 'settings.json'));
  } finally {
    cleanup(dir);
  }
});
