import path from 'node:path';
import { z } from 'zod';
import { DATA, readJSON, atomicJSON } from './state.js';
import { command } from './runner.js';
import { engineContext, target } from './engine-context.js';

export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,252}$/),
    user: z
      .string()
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/)
      .or(z.literal(''))
      .default(''),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    identityFile: z
      .string()
      .max(1024)
      .refine((s) => !/[\r\n\0]/.test(s))
      .default(''),
  })
  .strict();
const file = path.join(DATA, 'engines.json');
export const connections = () => readJSON(file, { selected: 'local', profiles: [] });
let writing = false;
export async function changeConnections(change) {
  if (writing) throw new Error('연결 설정 저장 중입니다. 다시 시도해 주세요.');
  writing = true;
  try {
    const cfg = await connections();
    await change(cfg);
    await atomicJSON(file, cfg);
    return cfg;
  } finally {
    writing = false;
  }
}
export async function resolveTarget(id) {
  if (id === 'local') return { id, name: '로컬 WSL' };
  const cfg = await connections();
  const profile = cfg.profiles.find((p) => p.id === id);
  if (!profile) throw new Error('엔진 프로필을 찾을 수 없습니다. 연결 대상을 다시 선택해 주세요.');
  return Object.freeze({ ...profile });
}
export const shellQuote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
export function sshArgs(profile, args) {
  const p = profileSchema.parse(
    Object.fromEntries(
      Object.entries(profile).filter(([k]) => !['id', 'revision', 'scopeId'].includes(k)),
    ),
  );
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    ...(p.user ? ['-l', p.user] : []),
    ...(p.port ? ['-p', String(p.port)] : []),
    ...(p.identityFile ? ['-i', p.identityFile] : []),
    '--',
    p.host,
    args.map(shellQuote).join(' '),
  ];
}
export function remoteCommand(args, options) {
  return command('ssh.exe', sshArgs(target(), args), options);
}
export async function testConnection(profile) {
  return engineContext.run(profile, async () => {
    const { dockerRequest } = await import('./engine.js');
    const version = await dockerRequest('GET', '/version', undefined, {
      timeout: 15000,
      pool: false,
    });
    if (!version?.Version || version.Components?.some((c) => /podman/i.test(c.Name)))
      throw new Error(
        'Docker 엔진을 확인해 주세요. Podman 전용 서버는 Docker 설치 후 연결할 수 있습니다.',
      );
    return { ok: true, version: version.Version, checkedAt: new Date().toISOString() };
  });
}
