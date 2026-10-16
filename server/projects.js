import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DATA, atomicJSON, readJSON, settings } from './state.js';
import { RANCHER_HOST } from './external.js';
import { command } from './runner.js';
import { ensureWindowsTool } from './tools.js';

// Compose labels every container it creates; these let Naru group and manage existing projects.
export const LABEL = {
  project: 'com.docker.compose.project',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
  envFiles: 'com.docker.compose.project.environment_file',
  service: 'com.docker.compose.service',
};
export const projectName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
const split = (value) => (value ? value.split(',').filter(Boolean) : []);

async function scope() {
  const shared = (await settings()).connection === 'rancher-desktop';
  return {
    registry: path.join(DATA, shared ? 'projects-shared.json' : 'projects.json'),
    managedDir: path.join(DATA, shared ? 'compose-shared' : 'compose'),
    host: shared ? RANCHER_HOST : 'npipe:////./pipe/naru_engine',
  };
}
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

// Projects come from container labels, Naru-saved compose files and earlier sightings, so a
// project stays listed after `down` and can be brought up again.
export async function listProjects(containers) {
  const { registry, managedDir } = await scope();
  const known = await readJSON(registry, {});
  const before = JSON.stringify(known);
  await fs.mkdir(managedDir, { recursive: true });
  for (const entry of await fs.readdir(managedDir, { withFileTypes: true }))
    if (entry.isDirectory() && projectName.safeParse(entry.name).success)
      known[entry.name] = {
        workingDir: path.join(managedDir, entry.name),
        configFiles: [path.join(managedDir, entry.name, 'compose.yaml')],
        envFiles: [],
        managed: true,
      };
  for (const c of containers) {
    const name = c.Labels?.[LABEL.project];
    if (!name || known[name]?.managed) continue;
    const workingDir = c.Labels[LABEL.workingDir];
    if (!workingDir) continue;
    known[name] = {
      workingDir,
      configFiles: split(c.Labels[LABEL.configFiles]),
      envFiles: split(c.Labels[LABEL.envFiles]),
      managed: false,
    };
  }
  if (JSON.stringify(known) !== before) await atomicJSON(registry, known);
  return Promise.all(
    Object.entries(known)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([name, p]) => ({
        name,
        ...p,
        filesFound:
          p.configFiles.length > 0 && (await Promise.all(p.configFiles.map(exists))).every(Boolean),
      })),
  );
}

export async function findProject(name, containers) {
  const project = (await listProjects(containers)).find((p) => p.name === name);
  if (!project) throw Error('프로젝트를 찾을 수 없습니다.');
  return project;
}

export async function forgetProject(name, containers) {
  if (containers.some((c) => c.Labels?.[LABEL.project] === name))
    throw Error('컨테이너가 남아 있는 프로젝트는 목록에서 제거할 수 없습니다.');
  const { registry, managedDir } = await scope();
  const known = await readJSON(registry, {});
  if (known[name]?.managed)
    await fs.rm(path.join(managedDir, name), { recursive: true, force: true });
  delete known[name];
  await atomicJSON(registry, known);
}

export async function readProjectFiles(project) {
  return Promise.all(
    project.configFiles.map(async (file) => {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) return { path: file, text: null };
      if (stat.size > 1024 * 1024) return { path: file, text: null, error: '파일이 너무 큽니다.' };
      return { path: file, text: await fs.readFile(file, 'utf8') };
    }),
  );
}

export async function saveManagedProject(name, yaml) {
  const { managedDir } = await scope();
  const folder = path.join(managedDir, name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'compose.yaml'), yaml);
}

// Runs Windows Compose against Naru's pipe; the pipe maps Windows bind paths for the engine.
export async function compose(project, args, options = {}) {
  const { host } = await scope();
  const binary = await ensureWindowsTool('compose', options.log);
  return command(
    binary,
    [
      '--project-name',
      project.name,
      '--project-directory',
      project.workingDir,
      ...project.configFiles.flatMap((file) => ['--file', file]),
      ...project.envFiles.flatMap((file) => ['--env-file', file]),
      ...args,
    ],
    {
      timeout: 30 * 60 * 1000,
      ...options,
      cwd: project.workingDir,
      env: { DOCKER_HOST: host, DOCKER_CONTEXT: '', COMPOSE_PROGRESS: 'plain' },
    },
  );
}
