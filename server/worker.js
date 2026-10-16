import { EXTERNAL_HOST, assertSharedJob } from './external.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, parseAllDocuments } from 'yaml';
import { DATA, DISTRO, settings, saveSettings, atomicJSON, readJSON } from './state.js';
import { wsl, command } from './runner.js';
import * as runtime from './runtime.js';
import * as engine from './engine.js';
import { validateJob } from './jobs.js';
import { createForward, stopForward, removeForward } from './forwarding.js';
import { ensureWindowsTool } from './tools.js';
import { compactDisk } from './disk.js';
import { installExtension, uninstallExtension } from './extensions.js';
import { ensureCredentialHelper } from './registry.js';
import * as projects from './projects.js';
import { LABEL, findProject, saveManagedProject } from './projects.js';

const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid job id');
const dir = path.join(DATA, 'jobs'),
  file = path.join(dir, `${id}.json`);
const logHandle = await fs.open(path.join(dir, `${id}.log`), 'a');
const log = (text) => logHandle.write(String(text));
let job = await readJSON(file);
const inputFile = path.join(dir, `${id}.input.json.private`);
let lock;
try {
  lock = await fs.open(path.join(DATA, 'runtime.lock'), 'wx');
  await lock.writeFile(String(process.pid));
  const p = validateJob(job.type, await readJSON(inputFile));
  job = { ...job, state: 'running', pid: process.pid, startedAt: new Date().toISOString() };
  await atomicJSON(file, job);
  const cfg = await settings();
  const external = cfg.connection === 'external-engine';
  assertSharedJob(job.type, cfg);
  switch (job.type) {
    case 'installRuntime':
      await runtime.install(log);
      break;
    case 'installExtension':
      await installExtension(p.image, log);
      break;
    case 'uninstallExtension':
      await uninstallExtension(p.id, log);
      break;
    case 'createForward':
      await createForward(p, log);
      break;
    case 'stopForward':
      await stopForward(p.id, log);
      break;
    case 'removeForward':
      await removeForward(p.id, log);
      break;
    case 'registryLogin':
      if (!external) await ensureCredentialHelper(log);
      await engine.cli(['login', p.server, '--username', p.username, '--password-stdin'], {
        input: p.password,
        timeout: 60000,
        log,
      });
      break;
    case 'registryLogout':
      await engine.cli(['logout', p.server], { log });
      break;
    case 'exportImage': {
      try {
        await fs.access(p.file);
        throw new Error('대상 파일이 이미 있습니다. 새 파일 이름을 지정해 주세요.');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await fs.mkdir(path.dirname(p.file), { recursive: true });
      const file = external ? p.file : await wsl(['wslpath', '-a', p.file]);
      await engine.cli(['save', '-o', file, p.image], { timeout: 15 * 60 * 1000, log });
      log(`이미지 저장 완료: ${p.file}\n`);
      break;
    }
    case 'importImage': {
      await fs.access(p.file);
      const file = await wsl(['wslpath', '-a', p.file]);
      await engine.cli(['load', '-i', file], { timeout: 15 * 60 * 1000, log });
      break;
    }
    case 'scanImage': {
      await runtime.requireReady();
      const tar = path.join(DATA, 'cache', 'trivy_0.72.0_Linux-64bit.tar.gz');
      try {
        await wsl(['test', '-x', '/usr/local/bin/trivy']);
      } catch {
        try {
          await fs.access(tar);
        } catch {
          await runtime.download(
            'https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_Linux-64bit.tar.gz',
            tar,
            log,
          );
        }
        if (
          (await runtime.sha256(tar)) !==
          'bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea'
        )
          throw new Error('Trivy SHA256 검증 실패.');
        const linux = await wsl(['wslpath', '-a', tar]);
        await wsl(['tar', '-xzf', linux, '-C', '/usr/local/bin', 'trivy']);
      }
      const input = `/var/lib/naru/scan-${id}.tar`;
      await engine.cli(['save', '-o', input, p.image], { timeout: 15 * 60 * 1000, log });
      try {
        await fs.mkdir(path.join(DATA, 'scans'), { recursive: true });
        const output = await wsl(['wslpath', '-a', path.join(DATA, 'scans', `${id}.json`)]);
        await wsl(
          [
            '/usr/local/bin/trivy',
            'image',
            '--input',
            input,
            '--scanners',
            'vuln',
            '--format',
            'json',
            '--output',
            output,
          ],
          { timeout: 15 * 60 * 1000, log },
        );
        const report = await readJSON(path.join(DATA, 'scans', `${id}.json`));
        const counts = {};
        for (const r of report.Results || [])
          for (const v of r.Vulnerabilities || [])
            counts[v.Severity] = (counts[v.Severity] || 0) + 1;
        log(
          JSON.stringify(
            {
              image: p.image,
              severityCounts: counts,
              report: path.join(DATA, 'scans', `${id}.json`),
            },
            null,
            2,
          ),
        );
      } finally {
        await wsl(['rm', '-f', input]);
      }
      break;
    }
    case 'startRuntime':
      await runtime.start(log);
      break;
    case 'stopRuntime':
      await runtime.stop(log);
      break;
    case 'compactDisk':
      await compactDisk(log);
      break;
    case 'startKubernetes':
      await runtime.startKubernetes(log);
      break;
    case 'stopKubernetes':
      await runtime.stopKubernetes(log);
      break;
    case 'installCLI': {
      const bin = path.join(DATA, 'bin');
      await fs.mkdir(bin, { recursive: true });
      const provenance = [];
      for (const name of ['docker', 'kubectl', 'helm', 'compose', 'buildx', 'wincred']) {
        const dest = await ensureWindowsTool(name, log);
        provenance.push({
          tool: name,
          sha256: await runtime.sha256(dest),
          source: 'Official checksum-verified release',
        });
      }
      await atomicJSON(path.join(bin, 'provenance.json'), provenance);
      const docker = path.join(bin, 'docker.exe'),
        configDir = path.join(DATA, 'docker');
      await fs.mkdir(configDir, { recursive: true });
      const dockerConfig = await readJSON(path.join(configDir, 'config.json'), {});
      dockerConfig.cliPluginsExtraDirs = [path.join(bin, 'cli-plugins')];
      dockerConfig.credsStore = 'wincred';
      await atomicJSON(path.join(configDir, 'config.json'), dockerConfig);
      const userConfigDir = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
      const userConfig = await readJSON(path.join(userConfigDir, 'config.json'), {});
      userConfig.cliPluginsExtraDirs = [
        ...new Set([...(userConfig.cliPluginsExtraDirs || []), path.join(bin, 'cli-plugins')]),
      ];
      await atomicJSON(path.join(userConfigDir, 'config.json'), userConfig);
      const contextName = external ? 'external-engine' : 'naru';
      const dockerHost = external ? EXTERNAL_HOST : 'npipe:////./pipe/naru_engine';
      const contexts = engine.lines(
        await command(docker, [
          '--config',
          userConfigDir,
          'context',
          'ls',
          '--format',
          '{{json .}}',
        ]),
      );
      if (!contexts.some((c) => c.Name === contextName))
        await command(
          docker,
          [
            '--config',
            userConfigDir,
            'context',
            'create',
            contextName,
            '--docker',
            'host=' + dockerHost,
          ],
          { log },
        );
      await command(
        docker,
        [
          '--config',
          userConfigDir,
          'context',
          'update',
          contextName,
          '--docker',
          'host=' + dockerHost,
        ],
        { log },
      );
      await command(docker, ['--config', userConfigDir, 'context', 'use', contextName], { log });
      await fs.unlink(path.join(bin, 'naru.cmd')).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      for (const tool of ['kubectl', 'helm'])
        await fs.writeFile(
          path.join(bin, `naru-${tool}.cmd`),
          `@echo off\r\n"${path.join(bin, tool + '.exe')}" --kubeconfig "${path.join(DATA, 'kubeconfig.yaml')}" %*\r\n`,
        );
      log(
        `Windows CLI 설치 완료: ${bin}\nDocker 기본 context: ${contextName}\ndocker ps\ndocker compose version\n`,
      );
      break;
    }
    case 'containerAction':
      await engine.containerAction(p.id, p.action, log);
      break;
    case 'pullImage':
      await engine.cli(['pull', p.image], { timeout: 15 * 60 * 1000, log });
      break;
    case 'pushImage':
      await engine.cli(['push', p.image], { timeout: 15 * 60 * 1000, log });
      break;
    case 'removeImage':
      await engine.cli(['image', 'rm', p.id], { log });
      break;
    case 'tagImage':
      await engine.cli(['tag', p.id, p.target], { log });
      break;
    case 'createVolume':
      await engine.cli(['volume', 'create', p.name], { log });
      break;
    case 'removeVolume':
      await engine.cli(['volume', 'rm', p.name], { log });
      break;
    case 'createNetwork':
      await engine.cli(['network', 'create', p.name], { log });
      break;
    case 'removeNetwork':
      await engine.cli(['network', 'rm', p.id], { log });
      break;
    case 'pruneResources': {
      const pruneArgs = ['system', 'prune', '-f'];
      if (p.all) pruneArgs.push('--all');
      if (p.volumes) pruneArgs.push('--volumes');
      await engine.cli(pruneArgs, { timeout: 15 * 60 * 1000, log });
      log('미사용 리소스 정리(Prune) 완료.\n');
      break;
    }
    case 'createContainer': {
      const args = ['run', '-d', '--restart', p.restart];
      if (p.name) args.push('--name', p.name);
      for (const port of p.ports)
        args.push('-p', `127.0.0.1:${port.host}:${port.container}/${port.protocol}`);
      for (const env of p.env) args.push('-e', env);
      for (const m of p.mounts) {
        if (m.source.includes(',') || m.target.includes(','))
          throw new Error('마운트 경로에는 쉼표를 사용할 수 없습니다.');
        const source = m.source.startsWith('/')
          ? m.source
          : /^[a-zA-Z]:[\\/]/.test(m.source)
            ? external
              ? m.source
              : await wsl(['wslpath', '-a', m.source])
            : m.source;
        args.push(
          '--mount',
          `type=${source.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(source) ? 'bind' : 'volume'},source=${source},target=${m.target}${m.readOnly ? ',readonly' : ''}`,
        );
      }
      args.push(p.image, ...p.command);
      await engine.cli(args, { timeout: 15 * 60 * 1000, log });
      break;
    }
    case 'buildImage': {
      const context = path.resolve(p.context);
      const stat = await fs.stat(context);
      if (!stat.isDirectory()) throw new Error('빌드 context는 폴더여야 합니다.');
      const target = external ? context : await wsl(['wslpath', '-a', context]);
      await engine.cli(['build', '-f', `${target}/${p.dockerfile}`, '-t', p.tag, target], {
        timeout: 30 * 60 * 1000,
        log,
      });
      break;
    }
    case 'compose': {
      const value = parse(p.yaml);
      if (!value?.services || typeof value.services !== 'object')
        throw new Error('Compose services 정의를 확인해 주세요.');
      await saveManagedProject(p.name, p.yaml);
      log('compose.yaml을 저장했습니다.\n');
      if (p.action === 'up') {
        const containers = await engine.list('containers');
        await projects.compose(await findProject(p.name, containers), ['up', '--detach'], { log });
      }
      break;
    }
    case 'project': {
      const containers = await engine.list('containers');
      const project = await findProject(p.name, containers);
      const members = containers.filter((c) => c.Labels?.[LABEL.project] === p.name);
      if (project.filesFound) {
        const args = { up: ['up', '--detach'], down: ['down'] }[p.action] || [p.action];
        await projects.compose(project, args, { log });
      } else if (['start', 'stop', 'restart'].includes(p.action)) {
        // Without the compose file only the existing containers can be driven.
        log('compose 파일이 없어 컨테이너를 직접 제어합니다.\n');
        for (const c of members) await engine.containerAction(c.Id, p.action, log);
      } else throw new Error('compose 파일을 찾을 수 없어 이 작업을 실행할 수 없습니다.');
      break;
    }
    case 'kubeApply': {
      const documents = parseAllDocuments(p.yaml);
      for (const doc of documents) if (doc.errors.length) throw doc.errors[0];
      await runtime.requireReady();
      await wsl(
        [
          '/usr/local/bin/k3s',
          'kubectl',
          '--kubeconfig',
          '/etc/naru/kubeconfig',
          'apply',
          '-f',
          '-',
        ],
        { input: p.yaml, timeout: 120000, log },
      );
      break;
    }
    case 'kubeDelete':
      await runtime.requireReady();
      await wsl(
        [
          '/usr/local/bin/k3s',
          'kubectl',
          '--kubeconfig',
          '/etc/naru/kubeconfig',
          '-n',
          p.namespace,
          'delete',
          p.kind,
          p.name,
          '--timeout=60s',
        ],
        { timeout: 90000, log },
      );
      break;
    case 'snapshot':
      await runtime.snapshot(p.name, log);
      break;
    case 'deleteSnapshot':
      await fs.unlink(path.join(DATA, 'snapshots', `${p.id}.tar`));
      await fs.unlink(path.join(DATA, 'snapshots', `${p.id}.json`));
      break;
    case 'restoreSnapshot': {
      const meta = await readJSON(path.join(DATA, 'snapshots', `${p.id}.json`));
      const tar = path.join(DATA, 'snapshots', `${p.id}.tar`);
      if ((await runtime.sha256(tar)) !== meta.sha256) throw new Error('스냅샷 검증 실패.');
      await runtime.stop(log);
      const backup = path.join(DATA, 'snapshots', `pre-restore-${Date.now()}.tar`);
      await command('wsl.exe', ['--export', DISTRO, backup], { timeout: 15 * 60 * 1000, log });
      await command('wsl.exe', ['--unregister', DISTRO], { timeout: 60000, log });
      try {
        await command(
          'wsl.exe',
          ['--import', DISTRO, path.join(DATA, 'wsl'), tar, '--version', '2'],
          { timeout: 15 * 60 * 1000, log },
        );
        await saveSettings(meta.settings);
      } catch (e) {
        log('복원 실패, 변경 전 배포판 복구를 시도합니다.\n');
        await command(
          'wsl.exe',
          ['--import', DISTRO, path.join(DATA, 'wsl'), backup, '--version', '2'],
          { timeout: 15 * 60 * 1000, log },
        );
        throw e;
      }
      log(`스냅샷 복원 완료. 변경 전 백업: ${backup}\n`);
      break;
    }
    default:
      throw new Error('Unknown job');
  }
  job = { ...job, state: 'succeeded', finishedAt: new Date().toISOString() };
} catch (e) {
  log(`\n오류: ${e.message}\n`);
  job = { ...job, state: 'failed', error: e.message, finishedAt: new Date().toISOString() };
  process.exitCode = 1;
} finally {
  await atomicJSON(file, job);
  await fs.unlink(inputFile).catch(() => {});
  if (lock) {
    await lock.close();
    await fs.unlink(path.join(DATA, 'runtime.lock')).catch(() => {});
  }
  await logHandle.close();
}
