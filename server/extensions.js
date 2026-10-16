import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { parse, stringify } from 'yaml';
import { DATA, ROOT, settings, atomicJSON, readJSON } from './state.js';
import { wsl, command } from './runner.js';
import { requireReady } from './runtime.js';
import { cli, list, dockerRequest } from './engine.js';
import { ensureCompose } from './tools.js';

const directory = path.join(DATA, 'extensions');
const tokens = new Map();
const safeAsset = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.includes('\0') && !p.replaceAll('\\', '/').split('/').includes('..'),
    '확장 파일 경로를 확인해 주세요.',
  );
const uiSchema = z
  .object({
    title: z.string().max(200),
    root: safeAsset,
    src: safeAsset,
    backend: z.object({ socket: safeAsset }).optional(),
  })
  .passthrough();
const metadataSchema = z
  .object({
    icon: safeAsset.optional(),
    ui: z.object({ 'dashboard-tab': uiSchema.optional() }).optional(),
    vm: z
      .object({
        image: z.string().optional(),
        composefile: safeAsset.optional(),
        exposes: z.object({ socket: z.string().regex(/^[a-zA-Z0-9_.-]+$/) }).optional(),
      })
      .passthrough()
      .optional(),
    host: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const idSchema = z.string().regex(/^[a-f0-9]{24}$/);
export async function extensions() {
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && idSchema.safeParse(e.name).success)
        .map((e) => readJSON(path.join(directory, e.name, 'extension.json'), null)),
    )
  ).filter(Boolean);
}

export async function installExtension(image, log) {
  await requireReady();
  const cfg = await settings();
  const id = createHash('sha256').update(image).digest('hex').slice(0, 24),
    folder = path.join(directory, id);
  try {
    await fs.access(path.join(folder, 'extension.json'));
    log('이미 설치된 확장입니다.\n');
    return;
  } catch {}
  await fs.mkdir(folder, { recursive: true });
  try {
    await cli(['image', 'inspect', image]);
  } catch {
    await cli(['pull', image], { timeout: 15 * 60 * 1000, log });
  }
  const unpackName = `naru-ext-unpack-${id}`;
  const cid = (await cli(['create', '--name', unpackName, image, '/bin/true'])).trim();
  const copy = async (source, dest) => {
    safeAsset.parse(source);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await cli(['cp', `${cid}:${source}`, await wsl(['wslpath', '-a', dest])], {
      timeout: 120000,
      log,
    });
  };
  try {
    await copy('/metadata.json', path.join(folder, 'metadata.json'));
    const metadata = metadataSchema.parse(await readJSON(path.join(folder, 'metadata.json')));
    const tab = metadata.ui?.['dashboard-tab'];
    if (tab) {
      await fs.mkdir(path.join(folder, 'ui'), { recursive: true });
      await copy(tab.root.replace(/\/$/, '') + '/.', path.join(folder, 'ui'));
      await validateTree(path.join(folder, 'ui'));
      const src = path.resolve(folder, 'ui', tab.src);
      if (!src.startsWith(path.join(folder, 'ui') + path.sep))
        throw new Error('확장 시작 페이지 경로가 잘못되었습니다.');
      await fs.access(src);
    }
    const binaries = [];
    for (const entry of metadata.host?.binaries || [])
      for (const binary of entry.windows || []) {
        safeAsset.parse(binary.path);
        const name = path.posix.basename(binary.path);
        await copy(binary.path, path.join(folder, 'bin', name));
        binaries.push(name);
      }
    const project = `naru-extension-${id}`;
    let vmContainer = null;
    if (metadata.vm?.image || metadata.vm?.composefile) {
      if (cfg.engine === 'moby') await ensureCompose(log);
      const composeFolder = path.join(folder, 'compose');
      await fs.mkdir(composeFolder, { recursive: true });
      let compose;
      if (metadata.vm.image)
        compose = {
          services: {
            backend: { image: metadata.vm.image.replaceAll('${DESKTOP_PLUGIN_IMAGE}', image) },
          },
        };
      else {
        const parent = path.posix.dirname(metadata.vm.composefile);
        await copy(parent.replace(/\/$/, '') + '/.', composeFolder);
        compose = parse(
          await fs.readFile(
            path.join(composeFolder, path.posix.basename(metadata.vm.composefile)),
            'utf8',
          ),
        );
      }
      if (!compose?.services || !Object.keys(compose.services).length)
        throw new Error('확장 Compose services 정의가 없습니다.');
      const socketDir = `/var/lib/naru/extensions/${id}/guest-services`;
      await wsl(['mkdir', '-p', socketDir]);
      for (const [service, config] of Object.entries(compose.services)) {
        if (config.image) config.image = config.image.replaceAll('${DESKTOP_PLUGIN_IMAGE}', image);
        config.labels = {
          ...(Array.isArray(config.labels)
            ? Object.fromEntries(config.labels.map((x) => x.split('=')))
            : config.labels || {}),
          'io.naru.extension': id,
        };
        if (metadata.vm.exposes?.socket) {
          config.volumes = (config.volumes || []).filter((v) =>
            typeof v === 'string'
              ? !v.includes(':/run/guest-services')
              : v.target !== '/run/guest-services',
          );
          config.volumes.push({ type: 'bind', source: socketDir, target: '/run/guest-services' });
        }
        if (!vmContainer) vmContainer = service;
      }
      const file = path.join(composeFolder, 'naru-compose.yaml');
      await fs.writeFile(file, stringify(compose));
      await cli(['compose', '-p', project, '-f', await wsl(['wslpath', '-a', file]), 'up', '-d'], {
        timeout: 15 * 60 * 1000,
        log,
      });
    }
    const record = {
      id,
      image,
      engine: cfg.engine,
      title: tab?.title || image,
      metadata,
      binaries,
      project,
      vmService: vmContainer,
      installedAt: new Date().toISOString(),
    };
    await atomicJSON(path.join(folder, 'extension.json'), record);
    const hook = metadata.host?.['x-ext-install']?.windows;
    if (hook) await runHost(record, typeof hook === 'string' ? [hook] : hook, {}, log);
    log('확장 설치 완료. UI는 별도 로컬 출처에서 격리하여 실행합니다.\n');
  } catch (e) {
    log('확장 설치가 완료되지 않았습니다. 설치 로그와 추출 파일을 보존합니다.\n');
    throw e;
  } finally {
    await cli(['rm', cid], { log }).catch(() => {});
  }
}
async function validateTree(folder) {
  const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true });
  if (entries.length > 20000) throw new Error('확장 UI 파일 수 제한을 초과했습니다.');
  for (const e of entries)
    if (e.isSymbolicLink()) throw new Error('확장 UI의 심볼릭 링크는 허용하지 않습니다.');
}
export async function uninstallExtension(id, log) {
  idSchema.parse(id);
  const folder = path.join(directory, id),
    ext = await readJSON(path.join(folder, 'extension.json'));
  await requireReady();
  const cfg = await settings();
  if (cfg.engine !== ext.engine) throw new Error('확장을 설치한 컨테이너 엔진으로 전환해 주세요.');
  const hook = ext.metadata.host?.['x-ext-uninstall']?.windows;
  if (hook) await runHost(ext, typeof hook === 'string' ? [hook] : hook, {}, log);
  if (ext.vmService)
    await cli(
      [
        'compose',
        '-p',
        ext.project,
        '-f',
        await wsl(['wslpath', '-a', path.join(folder, 'compose', 'naru-compose.yaml')]),
        'down',
      ],
      { timeout: 120000, log },
    );
  // The exact id directory is inside the dedicated extension store. Preserve user data elsewhere.
  const target = path.resolve(folder);
  if (path.dirname(target) !== path.resolve(directory)) throw new Error('확장 삭제 경로 오류');
  await fs.rm(target, { recursive: true });
  for (const [key, value] of tokens) if (value === id) tokens.delete(key);
  log('확장 제거 완료.\n');
}
async function runHost(ext, args, options, log) {
  const name = path.basename(args[0]);
  if (!ext.binaries.includes(name) || args[0].includes('..'))
    throw new Error('확장이 선언한 호스트 실행파일만 실행할 수 있습니다.');
  const bin = path.join(directory, ext.id, 'bin', name);
  return command(bin, args.slice(1), {
    ...options,
    timeout: options.timeout || 120000,
    fullResult: true,
    log,
    cwd: path.join(directory, ext.id, 'bin'),
    env: options.env || {},
  });
}

export function registerExtensions(app, port) {
  app.get('/api/extensions', async (req, res) => res.json(await extensions()));
  app.post('/api/extensions/:id/session', async (req, res) => {
    const id = idSchema.parse(req.params.id),
      ext = await readJSON(path.join(directory, id, 'extension.json'));
    const tab = ext.metadata.ui?.['dashboard-tab'];
    if (!tab) throw new Error('이 확장에는 UI가 없습니다.');
    const token = randomBytes(32).toString('hex');
    tokens.set(token, id);
    res.json({
      url: `http://${id}.localhost:${port + 1}/${tab.src}#naru-token=${token}`,
      title: ext.title,
    });
  });
  const isolated = express();
  isolated.disable('x-powered-by');
  isolated.use(express.json({ limit: '2mb' }));
  isolated.use((req, res, next) => {
    const match = String(req.headers.host || '').match(
      new RegExp(`^([a-f0-9]{24})\\.localhost:${port + 1}$`),
    );
    if (!match || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`))
      return res.sendStatus(403);
    req.extensionId = match[1];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  isolated.get('/sdk.js', (req, res) =>
    res.type('application/javascript').sendFile(path.join(ROOT, 'public', 'extension-sdk.js')),
  );
  isolated.post('/rpc/:id', async (req, res) => {
    const id = idSchema.parse(req.params.id),
      token = String(req.headers['x-extension-token'] || '');
    if (tokens.get(token) !== id || req.extensionId !== id) return res.sendStatus(401);
    const ext = await readJSON(path.join(directory, id, 'extension.json')),
      cfg = await settings();
    if (ext.engine !== cfg.engine) throw new Error('확장을 설치한 엔진으로 전환해 주세요.');
    await requireReady();
    const p = z
      .object({ method: z.string(), args: z.array(z.unknown()).default([]) })
      .parse(req.body);
    switch (p.method) {
      case 'containers':
      case 'images':
      case 'volumes': {
        const options = p.args[0] || {};
        if (cfg.engine === 'moby') {
          const params = new URLSearchParams();
          if (p.method === 'containers') {
            params.set('all', options.all ? '1' : '0');
            if (Number.isInteger(options.limit) && options.limit >= 0)
              params.set('limit', String(options.limit));
            if (options.size) params.set('size', '1');
          }
          if (p.method === 'images' && options.all) params.set('all', '1');
          if (options.filters)
            params.set(
              'filters',
              typeof options.filters === 'string'
                ? options.filters
                : JSON.stringify(options.filters),
            );
          const route = p.method === 'volumes' ? '/volumes' : `/${p.method}/json`;
          const result = await dockerRequest('GET', route + '?' + params.toString());
          return res.json(p.method === 'volumes' ? result.Volumes || [] : result);
        }
        const rows = await list(p.method);
        return res.json(
          p.method === 'containers' && !options.all
            ? rows.filter((r) => r.State === 'running')
            : rows,
        );
      }
      case 'dialog': {
        const options = z
          .object({
            title: z.string().max(200).optional(),
            defaultPath: z.string().max(2048).optional(),
            properties: z
              .array(
                z.enum([
                  'openFile',
                  'openDirectory',
                  'multiSelections',
                  'showHiddenFiles',
                  'createDirectory',
                  'promptToCreate',
                  'noResolveAliases',
                  'treatPackageAsDirectory',
                  'dontAddToRecent',
                ]),
              )
              .optional(),
            filters: z
              .array(
                z.object({ name: z.string().max(100), extensions: z.array(z.string().max(32)) }),
              )
              .optional(),
          })
          .parse(p.args[0] || {});
        const output = await command(
          'powershell.exe',
          [
            '-NoProfile',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(ROOT, 'scripts', 'extension-file-dialog.ps1'),
          ],
          { input: JSON.stringify(options), timeout: 10 * 60 * 1000 },
        );
        return res.json(JSON.parse(output));
      }
      case 'namespaces':
        return res.json(
          cfg.engine === 'moby' ? [] : (await cli(['namespace', 'list', '--quiet'])).split('\n'),
        );
      case 'host':
        return res.json({
          platform: 'win32',
          arch: os.arch(),
          hostname: os.hostname(),
          image: ext.image,
          id: ext.id,
        });
      case 'exec':
      case 'exec-stream': {
        const [scope, cmd, args, options = {}] = p.args;
        z.enum(['docker-cli', 'host', 'container']).parse(scope);
        z.string().min(1).parse(cmd);
        z.array(z.string()).max(500).parse(args);
        const streaming = p.method === 'exec-stream';
        let process;
        const execution = {
          timeout: streaming ? 30 * 60 * 1000 : 120000,
          fullResult: true,
          ...(options.namespace
            ? {
                namespace: z
                  .string()
                  .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
                  .parse(options.namespace),
              }
            : {}),
        };
        if (streaming) {
          res.type('application/x-ndjson');
          res.flushHeaders();
          execution.onOutput = (event) => {
            if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
          };
          execution.onSpawn = (child) => {
            process = child;
            res.once('close', () => {
              if (child.exitCode === null) child.kill();
            });
          };
        }
        try {
          let output;
          if (scope === 'host')
            output = await runHost(ext, [cmd, ...args], { ...execution, env: options.env || {} });
          else if (scope === 'docker-cli') output = await cli([cmd, ...args], execution);
          else {
            if (!ext.vmService) throw new Error('확장의 VM 서비스가 없습니다.');
            const file = await wsl([
              'wslpath',
              '-a',
              path.join(directory, id, 'compose', 'naru-compose.yaml'),
            ]);
            const execArgs = ['compose', '-p', ext.project, '-f', file, 'exec', '-T'];
            if (options.cwd) execArgs.push('-w', z.string().parse(options.cwd));
            for (const [key, value] of Object.entries(options.env || {}))
              execArgs.push('-e', `${key}=${value}`);
            output = await cli([...execArgs, ext.vmService, cmd, ...args], execution);
          }
          return streaming
            ? res.end(JSON.stringify({ code: output.code }) + '\n')
            : res.json(output);
        } catch (error) {
          if (streaming) return res.end(JSON.stringify({ error: error.message }) + '\n');
          throw error;
        }
      }
      case 'service': {
        const [config] = p.args;
        const socket = ext.metadata.vm?.exposes?.socket;
        if (!socket) throw new Error('확장의 Unix 소켓 서비스가 없습니다.');
        const method = z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
          .parse(config.method || 'GET');
        const url = z
          .string()
          .regex(/^\/(?!\/)/)
          .parse(config.url);
        const args = [
          'curl',
          '-sS',
          '--max-time',
          '60',
          '--unix-socket',
          `/var/lib/naru/extensions/${id}/guest-services/${socket}`,
          '-X',
          method,
        ];
        for (const [key, value] of Object.entries(config.headers || {})) {
          if (/[\r\n]/.test(key + value)) throw new Error('잘못된 HTTP 헤더');
          args.push('-H', `${key}: ${value}`);
        }
        if (config.data !== undefined) args.push('--data-binary', '@-');
        args.push('--write-out', '\n%{http_code}', 'http://localhost' + url);
        const output = await wsl(args, {
          input:
            config.data === undefined
              ? undefined
              : typeof config.data === 'string'
                ? config.data
                : JSON.stringify(config.data),
          timeout: 65000,
        });
        const end = output.lastIndexOf('\n'),
          body = output.slice(0, end),
          status = Number(output.slice(end + 1));
        if (status >= 400) return res.status(status).json({ error: body });
        try {
          return res.json(JSON.parse(body));
        } catch {
          return res.json(body);
        }
      }
      default:
        throw new Error('지원되지 않은 확장 API: ' + p.method);
    }
  });
  isolated.get('/{*file}', async (req, res) => {
    const id = req.extensionId,
      base = path.join(directory, id, 'ui');
    const requested = Array.isArray(req.params.file)
      ? req.params.file.join('/')
      : req.params.file || 'index.html';
    const file = path.resolve(base, requested);
    if (!file.startsWith(base + path.sep)) return res.sendStatus(403);
    if (file.endsWith('.html')) {
      const html = await fs.readFile(file, 'utf8');
      res
        .type('html')
        .send(html.replace(/<head[^>]*>/i, (match) => match + '<script src="/sdk.js"></script>'));
    } else res.sendFile(file);
  });
  isolated.use((err, req, res, next) => res.status(400).json({ error: err.message }));
  const server = isolated.listen(port + 1, '127.0.0.1', () =>
    console.log(`Extension isolation http://127.0.0.1:${port + 1}`),
  );
  server.on('error', (e) => console.error(e.message));
  return server;
}
