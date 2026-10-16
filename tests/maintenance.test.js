import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const localRoot = path.resolve('.local');
await fs.mkdir(localRoot, { recursive: true });
const folder = await fs.mkdtemp(path.join(localRoot, 'maintenance-'));
process.env.NARU_DATA_DIR = folder;
const { assertDistroAvailable, wsl, MAINTENANCE_FILE } = await import('../server/runner.js');
const { naruSocket } = await import('../server/engine.js');

test('disk compaction blocks other processes from waking the distribution', async () => {
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    assert.doesNotThrow(assertDistroAvailable);
    await fs.writeFile(MAINTENANCE_FILE, JSON.stringify({ pid: other.pid }));
    assert.throws(assertDistroAvailable, /디스크를 압축하는 중/);
    await assert.rejects(wsl(['true']), /디스크를 압축하는 중/);
    const socket = naruSocket();
    await new Promise((resolve) => socket.on('close', resolve));
    assert.ok(socket.destroyed);
    // 압축 작업 프로세스 자신은 배포판을 다룰 수 있다.
    await fs.writeFile(MAINTENANCE_FILE, JSON.stringify({ pid: process.pid }));
    assert.doesNotThrow(assertDistroAvailable);
    // 작업 프로세스가 죽어 남은 표시는 무시한다.
    await fs.writeFile(MAINTENANCE_FILE, JSON.stringify({ pid: 2147483646 }));
    assert.doesNotThrow(assertDistroAvailable);
  } finally {
    other.kill();
    if (!path.resolve(folder).startsWith(localRoot + path.sep))
      throw Error('Unexpected test cleanup path');
    await fs.rm(folder, { recursive: true, force: true });
  }
});
