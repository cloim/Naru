import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA =
  process.env.NARU_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Naru');
export const DISTRO = 'naru';
export const settingsSchema = z
  .object({
    connection: z.enum(['managed', 'external-engine']).default('managed'),
    engine: z.enum(['moby', 'containerd']).default('moby'),
    namespace: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
      .default('default'),
    autoStart: z.boolean().default(true),
    kubernetes: z
      .object({
        enabled: z.boolean().default(false),
        version: z
          .string()
          .regex(/^v1\.\d+\.\d+\+k3s\d+$/)
          .default('v1.34.1+k3s1'),
        port: z.number().int().min(1024).max(65535).default(6445),
        traefik: z.boolean().default(true),
      })
      .default({ enabled: false, version: 'v1.34.1+k3s1', port: 6445, traefik: true }),
    proxy: z
      .object({
        http: z.string().max(2048).default(''),
        https: z.string().max(2048).default(''),
        noProxy: z.string().max(4096).default('localhost,127.0.0.1,::1,.svc,.cluster.local'),
      })
      .default({ http: '', https: '', noProxy: 'localhost,127.0.0.1,::1,.svc,.cluster.local' }),
    pollSeconds: z.number().int().min(3).max(60).default(5),
  })
  .strict()
  .refine((value) => value.connection !== 'external-engine' || value.engine === 'moby', {
    message: 'External Engine 공유 연결은 Docker 엔진을 사용합니다.',
  });

export async function atomicJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}
export async function settings() {
  return settingsSchema.parse(await readJSON(path.join(DATA, 'settings.json'), {}));
}
export async function saveSettings(input) {
  const value = settingsSchema.parse(input);
  if (value.connection === 'external-engine' && value.engine !== 'moby')
    throw Error('External Engine 공유 연결은 Docker 엔진을 사용합니다.');
  await atomicJSON(path.join(DATA, 'settings.json'), value);
  return value;
}

// These only affect the screen or the next server start, so they can change while the engine runs.
export const LIVE_SETTINGS = ['pollSeconds', 'autoStart'];
export function engineSettingsChanged(previous, next) {
  const strip = (value) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value).filter(([k]) => !LIVE_SETTINGS.includes(k))),
    );
  return strip(previous) !== strip(next);
}
