// Run after pnpm build:main with the same Node version used for native modules:
// node --expose-gc scripts/benchmark-session-output.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseService } = require('../main/dist/main/src/database/database.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-output-benchmark-'));
const db = new DatabaseService(path.join(directory, 'sessions.db'));
const rowCount = 10000;
const payload = 'x'.repeat(8192);

function measure(readCount) {
  const times = [];
  const heaps = [];
  for (let i = 0; i < 9; i++) {
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    assert.equal(readCount(), rowCount);
    times.push(performance.now() - started);
    heaps.push(process.memoryUsage().heapUsed - heapBefore);
  }
  times.sort((a, b) => a - b);
  heaps.sort((a, b) => a - b);
  return { medianMs: Number(times[4].toFixed(3)), medianHeapMiB: Number((heaps[4] / 1024 / 1024).toFixed(3)) };
}

try {
  db.initialize();
  db.createSession({ id: 'benchmark', name: 'Benchmark', initial_prompt: '', worktree_name: 'benchmark', worktree_path: directory, project_id: null, tool_type: 'none' });
  db.transaction(() => {
    for (let i = 0; i < rowCount; i++) db.addSessionOutput('benchmark', 'stdout', payload);
  });
  // Warm both query paths before collecting median measurements.
  db.getSessionOutputs('benchmark');
  db.getSessionOutputCount('benchmark');
  console.log(JSON.stringify({
    node: process.version,
    rows: rowCount,
    payloadMiB: rowCount * payload.length / 1024 / 1024,
    loadHistoryThenCount: measure(() => db.getSessionOutputs('benchmark').length),
    countInDatabase: measure(() => db.getSessionOutputCount('benchmark')),
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
