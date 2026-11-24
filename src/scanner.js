'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CHUNK_SIZE = 1024 * 1024;
const ASSISTANT_MARKERS = ['"type":"assistant"', '"type": "assistant"'];

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function hasAssistantMarker(line) {
  for (const marker of ASSISTANT_MARKERS) {
    if (line.includes(marker)) return true;
  }
  return false;
}

async function discoverJsonl(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) files.push(fullPath);
    }
  }
  await walk(root);
  files.sort();
  return files;
}

class TranscriptScanner {
  constructor() {
    this.files = new Map();
    this.lastStats = { files: 0, bytesRead: 0, assistantRows: 0, malformedLines: 0, durationMs: 0 };
  }

  reset() {
    this.files.clear();
  }

  async scanAll(root, onAssistant) {
    this.reset();
    const started = Date.now();
    const paths = await discoverJsonl(root);
    let bytesRead = 0;
    let assistantRows = 0;
    let malformedLines = 0;
    for (const file of paths) {
      const result = await this._readFrom(file, 0, Buffer.alloc(0), onAssistant);
      bytesRead += result.bytesRead;
      assistantRows += result.assistantRows;
      malformedLines += result.malformedLines;
    }
    this.lastStats = { files: paths.length, bytesRead, assistantRows, malformedLines, durationMs: Date.now() - started };
    return this.lastStats;
  }

  async scanIncremental(root, onAssistant) {
    const started = Date.now();
    const paths = await discoverJsonl(root);
    const current = new Set(paths);
    for (const known of this.files.keys()) {
      if (!current.has(known)) {
        return { needsRebuild: true, files: paths.length, bytesRead: 0, assistantRows: 0, malformedLines: 0, durationMs: Date.now() - started };
      }
    }

    let bytesRead = 0;
    let assistantRows = 0;
    let malformedLines = 0;
    for (const file of paths) {
      const state = this.files.get(file);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        return { needsRebuild: true, files: paths.length, bytesRead: 0, assistantRows: 0, malformedLines: 0, durationMs: Date.now() - started };
      }
      if (state && stat.size < state.offset) {
        return { needsRebuild: true, files: paths.length, bytesRead: 0, assistantRows: 0, malformedLines: 0, durationMs: Date.now() - started };
      }
      if (state && stat.size === state.offset) continue;
      const result = await this._readFrom(file, state ? state.offset : 0, state ? state.pending : Buffer.alloc(0), onAssistant);
      bytesRead += result.bytesRead;
      assistantRows += result.assistantRows;
      malformedLines += result.malformedLines;
    }
    this.lastStats = { files: paths.length, bytesRead, assistantRows, malformedLines, durationMs: Date.now() - started };
    return { needsRebuild: false, ...this.lastStats };
  }

  async _readFrom(file, startOffset, initialPending, onAssistant) {
    const state = {
      path: file,
      offset: startOffset,
      pending: Buffer.from(initialPending || Buffer.alloc(0)),
      errors: 0
    };
    let bytesRead = 0;
    let assistantRows = 0;
    let malformedLines = 0;
    let firstLine = startOffset === 0;
    let handle = null;

    try {
      handle = await fsp.open(file, 'r');
      const buffer = Buffer.alloc(CHUNK_SIZE);
      while (true) {
        const { bytesRead: readBytes } = await handle.read(buffer, 0, CHUNK_SIZE, state.offset);
        if (readBytes <= 0) break;
        state.offset += readBytes;
        bytesRead += readBytes;
        state.pending = Buffer.concat([state.pending, buffer.subarray(0, readBytes)]);
        const lastNewline = state.pending.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          const complete = state.pending.subarray(0, lastNewline + 1).toString('utf8');
          state.pending = Buffer.from(state.pending.subarray(lastNewline + 1));
          const parsed = await this._parseLines(complete, onAssistant, file, firstLine);
          firstLine = false;
          assistantRows += parsed.assistantRows;
          malformedLines += parsed.malformedLines;
        }
        await yieldToEventLoop();
      }
    } catch {
      state.errors += 1;
    } finally {
      if (handle) {
        try { await handle.close(); } catch {}
      }
    }

    this.files.set(file, state);
    return { bytesRead, assistantRows, malformedLines };
  }

  async _parseLines(text, onAssistant, file, stripBom) {
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let assistantRows = 0;
    let malformedLines = 0;
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index];
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (index === 0 && stripBom && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      if (!line || !hasAssistantMarker(line)) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      if (parsed && parsed.type === 'assistant') {
        assistantRows += 1;
        onAssistant(parsed, file);
      }
      if ((index & 255) === 255) await yieldToEventLoop();
    }
    return { assistantRows, malformedLines };
  }

  getFileStats() {
    return Array.from(this.files.values()).map(state => ({
      path: state.path,
      offset: state.offset,
      pendingBytes: state.pending.length,
      errors: state.errors
    }));
  }
}

module.exports = { TranscriptScanner, discoverJsonl };
