import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const localRoot = path.resolve('.local');
await fs.mkdir(localRoot, { recursive: true });
const folder = await fs.mkdtemp(path.join(localRoot, 'job-recovery-'));
process.env.NARU_DATA_DIR = folder;
const { reconcileJobs } = await import('../server/jobs.js');
const { atomicJSON, readJSON } = await import('../server/state.js');

test('interrupted jobs recover, live workers and fresh dispatch remain active', async () => {
  const records = [
    { id: crypto.randomUUID(), state: 'running', pid: 2147483646 },
    { id: crypto.randomUUID(), state: 'running', pid: 2147483647 },
    { id: crypto.randomUUID(), state: 'running', pid: process.pid },
    { id: crypto.randomUUID(), state: 'queued', createdAt: new Date().toISOString() },
    {
      id: crypto.randomUUID(),
      state: 'queued',
      createdAt: new Date(Date.now() - 60000).toISOString(),
    },
  ];
  const originalKill = process.kill;
  try {
    for (const j of records) {
      await atomicJSON(path.join(folder, 'jobs', j.id + '.json'), {
        type: 'startRuntime',
        createdAt: new Date().toISOString(),
        ...j,
      });
      await atomicJSON(path.join(folder, 'jobs', j.id + '.input.json.private'), {});
    }
    await fs.writeFile(path.join(folder, 'runtime.lock'), '2147483647');
    process.kill = (pid, signal) => {
      if (pid !== 2147483646) return originalKill(pid, signal);
      writeFileSync(
        path.join(folder, 'jobs', records[0].id + '.json'),
        JSON.stringify({ ...records[0], state: 'succeeded' }),
      );
      throw Object.assign(new Error('Worker completed before liveness check'), { code: 'ESRCH' });
    };
    await reconcileJobs();
    const updated = await Promise.all(
      records.map((j) => readJSON(path.join(folder, 'jobs', j.id + '.json'))),
    );
    assert.deepEqual(
      updated.map((j) => j.state),
      ['succeeded', 'failed', 'running', 'queued', 'failed'],
    );
    assert.ok(updated[1].finishedAt);
    await assert.rejects(fs.access(path.join(folder, 'runtime.lock')), { code: 'ENOENT' });
    await assert.rejects(
      fs.access(path.join(folder, 'jobs', records[1].id + '.input.json.private')),
      { code: 'ENOENT' },
    );
    await fs.access(path.join(folder, 'jobs', records[2].id + '.input.json.private'));
  } finally {
    process.kill = originalKill;
    if (!path.resolve(folder).startsWith(localRoot + path.sep))
      throw Error('Unexpected test cleanup path');
    await fs.rm(folder, { recursive: true, force: true });
  }
});
