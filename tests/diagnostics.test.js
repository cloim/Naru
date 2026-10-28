import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemory, parseContainerStats, systemSample } from '../server/diagnostics.js';

test('diagnostic memory parsing handles Docker and nerdctl units', () => {
  assert.equal(parseMemory('4.5MiB'), 4.5 * 1024 ** 2);
  assert.equal(parseMemory('1.2 GiB'), 1.2 * 1024 ** 3);
  assert.equal(parseMemory('22.4MB'), 22400000);
  assert.equal(parseMemory('0B'), 0);
  for (const invalid of ['N/A', '', '-1MB', '12']) assert.throws(() => parseMemory(invalid));
});

test('container samples preserve multicore CPU and identify each running container', () => {
  assert.deepEqual(
    parseContainerStats('abc\tweb\t123.50%\t4MiB / 2GiB\r\ndef\tdb\t0.00%\t0B / 2GiB\n'),
    [
      { id: 'abc', name: 'web', cpu: 123.5, memory: 4194304 },
      { id: 'def', name: 'db', cpu: 0, memory: 0 },
    ],
  );
  assert.deepEqual(parseContainerStats(''), []);
  assert.throws(() => parseContainerStats('abc\tweb\tN/A\t4MiB / 2GiB'));
  assert.throws(() => parseContainerStats('abc\tweb\t0%\tN/A'));
});

test('system samples distinguish process RSS and host memory, warming up CPU deltas', () => {
  const first = systemSample();
  assert.equal(first.server.cpu, null);
  assert.equal(first.host.cpu, null);
  assert.ok(first.server.memory > 0);
  assert.ok(first.host.memory > 0 && first.host.memory <= first.host.limit);
  const second = systemSample();
  assert.ok(Number.isFinite(second.server.cpu) && second.server.cpu >= 0);
  assert.ok(second.host.cpu === null || (second.host.cpu >= 0 && second.host.cpu <= 100));
});
