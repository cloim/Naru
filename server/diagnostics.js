import os from 'node:os';
import * as engine from './engine.js';
import * as runtime from './runtime.js';

export function parseMemory(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!match) throw new Error('리소스 메모리 형식을 확인해 주세요.');
  const unit = match[2].toLowerCase();
  const power = ['b', 'k', 'm', 'g', 't'].indexOf(unit[0]);
  return Number(match[1]) * (unit.includes('i') ? 1024 : 1000) ** power;
}

export function parseContainerStats(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [id, name, percent, memory] = line.split('\t');
      const cpu = Number(percent?.replace('%', ''));
      if (!id || !name || !percent?.endsWith('%') || !Number.isFinite(cpu) || cpu < 0)
        throw new Error('컨테이너 리소스 형식을 확인해 주세요.');
      return { id, name, cpu, memory: parseMemory(memory?.split('/')[0]) };
    });
}

let previous;
let pending;
let cached;

export function systemSample() {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const cores = os.cpus();
  const total = cores.reduce(
    (sum, core) => sum + Object.values(core.times).reduce((a, b) => a + b, 0),
    0,
  );
  const idle = cores.reduce((sum, core) => sum + core.times.idle, 0);
  const elapsed = previous ? Number(now - previous.now) / 1000 : 0;
  const result = {
    server: {
      cpu:
        elapsed > 0
          ? Math.max(
              0,
              ((cpu.user + cpu.system - previous.cpu.user - previous.cpu.system) / elapsed) * 100,
            )
          : null,
      memory: process.memoryUsage().rss,
    },
    host: {
      cpu:
        previous && total > previous.total
          ? Math.min(
              100,
              Math.max(0, (1 - (idle - previous.idle) / (total - previous.total)) * 100),
            )
          : null,
      memory: os.totalmem() - os.freemem(),
      limit: os.totalmem(),
      cores: cores.length,
    },
  };
  previous = { now, cpu, total, idle };
  return result;
}

// Share an in-flight sample across clients; polling never starts overlapping CLI processes.
export async function resourceSample() {
  if (cached && Date.now() - cached.timestamp < 2000) return cached;
  if (pending) return pending;
  pending = (async () => {
    let containers = null;
    let containerError = null;
    try {
      const state = await runtime.status();
      if (state.running) {
        containers = parseContainerStats(
          await engine.cli(
            ['stats', '--no-stream', '--format', '{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'],
            { timeout: 12000 },
          ),
        );
      } else containerError = '엔진을 시작하면 컨테이너 사용량을 확인할 수 있습니다.';
    } catch (error) {
      containerError = error.message;
    }
    cached = { timestamp: Date.now(), ...systemSample(), containers, containerError };
    return cached;
  })().finally(() => {
    pending = null;
  });
  return pending;
}
