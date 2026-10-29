import assert from 'node:assert/strict';
import test from 'node:test';
import { validTargets } from '../server/ports.js';

test('에이전트 목록에서 허용된 대상과 포트만 남긴다', () => {
  const ok = [
    { port: 5432, target: '127.0.0.1:5432' },
    { port: 8080, target: '[::1]:8080' },
    { port: 80, target: '198.19.249.2:80' },
  ];
  const bad = [
    { port: 22, target: '10.0.0.1:22' },
    { port: 0, target: '127.0.0.1:1' },
    { port: 70000, target: '127.0.0.1:70000' },
    { port: 9000, target: '127.0.0.1:0' },
    { port: '81', target: '127.0.0.1:81' },
    { port: 82, target: '127.0.0.1:82\nDATA x' },
    null,
  ];
  assert.deepEqual(validTargets([...ok, ...bad]), ok);
  assert.deepEqual(validTargets(undefined), []);
});
