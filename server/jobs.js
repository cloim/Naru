import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DATA, ROOT, atomicJSON, readJSON, settings } from './state.js';
import { detached } from './runner.js';
import { projectName } from './projects.js';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,511}$/);
export const image = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,511}$/);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const empty = z.object({}).strict();
export const jobSchemas = {
  installRuntime: empty,
  startRuntime: empty,
  stopRuntime: empty,
  compactDisk: empty,
  startKubernetes: empty,
  stopKubernetes: empty,
  installCLI: empty,
  containerAction: z
    .object({
      id: identifier,
      action: z.enum(['start', 'stop', 'restart', 'pause', 'unpause', 'remove']),
    })
    .strict(),
  createContainer: z
    .object({
      image,
      name: name.optional(),
      ports: z
        .array(
          z.object({
            host: z.number().int().min(1024).max(65535),
            container: z.number().int().min(1).max(65535),
            protocol: z.enum(['tcp', 'udp']).default('tcp'),
          }),
        )
        .max(20)
        .default([]),
      env: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=[^\x00\r\n]*$/))
        .max(100)
        .default([]),
      mounts: z
        .array(
          z.object({
            source: z.string().min(1).max(1024),
            target: z.string().regex(/^\/[^\x00]*$/),
            readOnly: z.boolean().default(false),
          }),
        )
        .max(20)
        .default([]),
      command: z.array(z.string().max(4096)).max(100).default([]),
      restart: z.enum(['no', 'unless-stopped', 'always', 'on-failure']).default('no'),
    })
    .strict(),
  pullImage: z.object({ image }).strict(),
  pushImage: z.object({ image }).strict(),
  removeImage: z.object({ id: identifier }).strict(),
  tagImage: z.object({ id: identifier, target: image }).strict(),
  buildImage: z
    .object({
      context: z.string().min(1).max(2048),
      tag: image,
      dockerfile: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]*$/)
        .refine((s) => !s.split('/').includes('..'), '상위 폴더 참조는 허용되지 않습니다.')
        .default('Dockerfile'),
    })
    .strict(),
  createVolume: z.object({ name }).strict(),
  removeVolume: z.object({ name }).strict(),
  createNetwork: z.object({ name }).strict(),
  removeNetwork: z.object({ id: identifier }).strict(),
  project: z
    .object({
      name: projectName,
      action: z.enum(['start', 'stop', 'restart', 'up', 'down', 'pull', 'build']),
    })
    .strict(),
  compose: z
    .object({
      name: projectName,
      yaml: z
        .string()
        .min(1)
        .max(1024 * 1024),
      action: z.enum(['save', 'up']),
    })
    .strict(),
  kubeApply: z
    .object({
      yaml: z
        .string()
        .min(1)
        .max(1024 * 1024),
    })
    .strict(),
  kubeDelete: z
    .object({
      kind: z.enum([
        'pods',
        'deployments',
        'services',
        'configmaps',
        'persistentvolumeclaims',
        'namespaces',
      ]),
      name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/),
      namespace: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .default('default'),
    })
    .strict(),
  snapshot: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
  restoreSnapshot: z.object({ id: z.uuid(), confirmation: z.literal('RESTORE') }).strict(),
  deleteSnapshot: z.object({ id: z.uuid(), confirmation: z.literal('DELETE') }).strict(),
  createForward: z
    .object({
      resource: z.string().regex(/^(pod|svc|deployment)\/[a-z0-9][a-z0-9.-]{0,252}$/),
      namespace: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .default('default'),
      localPort: z.number().int().min(1024).max(65535),
      remotePort: z.number().int().min(1).max(65535),
    })
    .strict(),
  stopForward: z.object({ id: z.uuid() }).strict(),
  removeForward: z.object({ id: z.uuid() }).strict(),
  registryLogin: z
    .object({
      server: z
        .string()
        .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?|https:\/\/index\.docker\.io\/v1\/)$/),
      username: z.string().min(1).max(256),
      password: z.string().min(1).max(4096),
    })
    .strict(),
  registryLogout: z
    .object({
      server: z
        .string()
        .regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?|https:\/\/index\.docker\.io\/v1\/)$/),
    })
    .strict(),
  exportImage: z.object({ image, file: z.string().regex(/^[a-zA-Z]:[\\/].+\.tar$/) }).strict(),
  importImage: z.object({ file: z.string().regex(/^[a-zA-Z]:[\\/].+\.tar$/) }).strict(),
  scanImage: z.object({ image }).strict(),
  installExtension: z.object({ image, confirmation: z.literal('TRUST') }).strict(),
  uninstallExtension: z
    .object({ id: z.string().regex(/^[a-f0-9]{24}$/), confirmation: z.literal('REMOVE') })
    .strict(),
  pruneResources: z
    .object({
      all: z.boolean().default(true),
      volumes: z.boolean().default(false),
    })
    .default({}),
  pruneImages: empty,
  pruneVolumes: empty,
  pruneNetworks: empty,
};
export function validateJob(type, payload) {
  const schema = jobSchemas[type];
  if (!schema) throw new Error('지원하지 않는 작업입니다.');
  return schema.parse(payload);
}
export async function jobList() {
  const dir = path.join(DATA, 'jobs');
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((x) => x.endsWith('.json'));
  return (await Promise.all(files.map((x) => readJSON(path.join(dir, x))))).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}
// 끝난 작업 기록은 최근 30일, 최대 200건만 남긴다. 같은 id로 시작하는 로그, 입력 사본, 임시 파일도 함께 지운다.
// 기록이 없는 파일은 접수 중일 수 있으므로(입력 사본을 기록보다 먼저 쓴다) 1시간이 지난 것만 지운다.
const JOB_KEEP_DAYS = 30,
  JOB_KEEP_COUNT = 200,
  ORPHAN_GRACE_MS = 3600000;
export async function pruneJobs(now = Date.now()) {
  const dir = path.join(DATA, 'jobs'),
    jobs = await jobList(),
    cutoff = now - JOB_KEEP_DAYS * 86400000;
  const kept = new Set(
    jobs
      .filter(
        (job, index) =>
          ['queued', 'running'].includes(job.state) ||
          (index < JOB_KEEP_COUNT && Date.parse(job.createdAt) >= cutoff),
      )
      .map((job) => job.id),
  );
  const recorded = new Map(jobs.map((job) => [job.id, job]));
  for (const file of await fs.readdir(dir)) {
    const id = file.slice(0, 36),
      target = path.join(dir, file),
      job = recorded.get(id);
    const finished = job && !['queued', 'running'].includes(job.state);
    // 남길 작업이라도 끝난 작업의 입력 사본은 지운다. 임시 파일은 쓰는 중일 수 있어 유예한다.
    if (
      kept.has(id) &&
      !(finished && file.endsWith('.input.json.private')) &&
      !file.endsWith('.tmp')
    )
      continue;
    if (!job || file.endsWith('.tmp')) {
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || now - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
    }
    await fs.rm(target, { force: true });
  }
}
let submitting = false;
export async function reconcileJobs() {
  for (const job of await jobList()) {
    if (!['running', 'queued'].includes(job.state)) continue;
    if (job.state === 'queued' && Date.now() - Date.parse(job.createdAt) < 30000) continue;
    let alive = false;
    if (job.pid)
      try {
        process.kill(job.pid, 0);
        alive = true;
      } catch {}
    if (alive) continue;
    // The worker may have persisted success between the directory scan and liveness check.
    const latest = await readJSON(path.join(DATA, 'jobs', job.id + '.json'));
    if (!['running', 'queued'].includes(latest.state)) continue;
    if (latest.pid !== job.pid || latest.state !== job.state) continue;
    await atomicJSON(path.join(DATA, 'jobs', job.id + '.json'), {
      ...job,
      state: 'failed',
      error: '작업 프로세스가 종료되었습니다. 로그를 확인하고 다시 실행해 주세요.',
      finishedAt: new Date().toISOString(),
    });
    await fs.unlink(path.join(DATA, 'jobs', job.id + '.input.json.private')).catch(() => {});
  }
  try {
    const lockFile = path.join(DATA, 'runtime.lock');
    const pid = Number(await fs.readFile(lockFile, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (!alive) await fs.unlink(lockFile);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await pruneJobs();
}
export async function submit(type, input) {
  const payload = validateJob(type, input);
  if (submitting) throw new Error('다른 작업을 접수 중입니다.');
  submitting = true;
  try {
    await reconcileJobs();
    const active = (await jobList()).find((j) => ['queued', 'running'].includes(j.state));
    if (active) throw new Error(`진행 중인 작업이 있습니다: ${active.type}`);
    const id = crypto.randomUUID(),
      dir = path.join(DATA, 'jobs');
    const job = { id, type, state: 'queued', createdAt: new Date().toISOString() };
    await atomicJSON(path.join(dir, `${id}.input.json.private`), payload);
    await atomicJSON(path.join(dir, `${id}.json`), job);
    // Persist first; dispatch independently so the UI receives its durable job id immediately.
    detached('cmd.exe', [
      '/d',
      '/c',
      path.join(ROOT, 'scripts', 'worker.cmd'),
      id,
      process.execPath,
    ]).catch(async (e) => {
      await atomicJSON(path.join(dir, `${id}.json`), {
        ...job,
        state: 'failed',
        error: e.message,
        finishedAt: new Date().toISOString(),
      });
    });
    return job;
  } finally {
    submitting = false;
  }
}
