import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsvPath = path.join(root, 'tests', 'regressions.tsv');

function collectRustTests(dir, found = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRustTests(full, found);
    } else if (entry.name.endsWith('.rs')) {
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(/\bfn\s+([a-zA-Z0-9_]+)\s*\(/g)) {
        found.add(match[1]);
      }
    }
  }
  return found;
}

test('tests/regressions.tsv에 등록된 회귀 검사가 모두 코드에 남아 있다', () => {
  const lines = fs
    .readFileSync(tsvPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  assert.ok(lines.length > 0, 'regressions.tsv에 최소 1개 이상의 회귀 항목이 있어야 합니다');

  const rustFns = collectRustTests(path.join(root, 'crates'));
  const seen = new Set();

  for (const line of lines) {
    const parts = line.split('\t');
    assert.equal(parts.length, 3, `탭으로 구분된 3열(이름, 참조, 설명)이 아닙니다: ${line}`);
    const [name, ref, summary] = parts;
    assert.ok(name && ref && summary, `빈 열이 있습니다: ${line}`);
    assert.ok(!seen.has(name), `중복된 회귀 항목입니다: ${name}`);
    seen.add(name);

    if (name.includes('/')) {
      assert.ok(fs.existsSync(path.join(root, name)), `회귀 시험 파일이 사라졌습니다: ${name}`);
    } else {
      assert.ok(rustFns.has(name), `회귀 Rust 시험 함수가 사라졌습니다: ${name}`);
    }
  }
});
