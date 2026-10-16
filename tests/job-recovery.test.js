import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const localRoot = path.resolve('.local');
await fs.mkdir(localRoot, { recursive: true });
const folder = await fs.mkdtemp(path.join(localRoot, 'job-recovery-'));
process.env.NARU_DATA_DIR = folder;
const { reconcileJobs, pruneJobs } = await import('../server/jobs.js');
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
        JSON.stringify({ ...records[0], createdAt: new Date().toISOString(), state: 'succeeded' }),
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

test('finished job history keeps 30 days and 200 records, in-flight files survive', async () => {
  const jobs = path.join(folder, 'jobs'),
    day = 86400000,
    now = Date.now();
  await fs.mkdir(jobs, { recursive: true });
  const write = async (state, age) => {
    const id = crypto.randomUUID();
    await atomicJSON(path.join(jobs, id + '.json'), {
      id,
      type: 'startRuntime',
      state,
      createdAt: new Date(now - age).toISOString(),
    });
    await fs.writeFile(path.join(jobs, id + '.log'), '');
    return id;
  };
  try {
    const old = await write('succeeded', 31 * day);
    const oldRunning = await write('running', 31 * day);
    const recent = [];
    for (let i = 0; i < 201; i++) recent.push(await write('failed', i * 1000));
    await fs.writeFile(path.join(jobs, recent[0] + '.input.json.private'), '{}');
    const pending = crypto.randomUUID();
    await fs.writeFile(path.join(jobs, pending + '.input.json.private'), '{}');
    await pruneJobs(now);
    const left = new Set(await fs.readdir(jobs));
    assert.ok(!left.has(old + '.json') && !left.has(old + '.log'));
    assert.ok(left.has(oldRunning + '.json'));
    assert.ok(left.has(recent[199] + '.json') && !left.has(recent[200] + '.json'));
    assert.ok(!left.has(recent[0] + '.input.json.private'));
    assert.ok(left.has(pending + '.input.json.private'));
  } finally {
    if (!path.resolve(folder).startsWith(localRoot + path.sep))
      throw Error('Unexpected test cleanup path');
    await fs.rm(folder, { recursive: true, force: true });
  }
});
