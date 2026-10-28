import { z } from 'zod';
import {
  connections,
  changeConnections,
  profileSchema,
  resolveTarget,
  testConnection,
} from './connections.js';
import { engineContext, remoteTarget } from './engine-context.js';

export function registerConnections(app) {
  app.get('/api/engines', async (req, res) => res.json(await connections()));
  app.post('/api/engines', async (req, res) => {
    const profile = {
      ...profileSchema.parse(req.body),
      id: crypto.randomUUID(),
      scopeId: crypto.randomUUID(),
      revision: crypto.randomUUID(),
    };
    await changeConnections((cfg) => {
      cfg.profiles.push(profile);
    });
    res.status(201).json(profile);
  });
  app.put('/api/engines/:id', async (req, res) => {
    const input = profileSchema.parse(req.body);
    await changeConnections((cfg) => {
      const i = cfg.profiles.findIndex((p) => p.id === req.params.id);
      if (i < 0) throw new Error('연결 프로필을 찾을 수 없습니다.');
      const previous = cfg.profiles[i];
      const sameEndpoint = ['host', 'user', 'port', 'identityFile'].every(
        (key) => previous[key] === input[key],
      );
      cfg.profiles[i] = {
        ...input,
        id: req.params.id,
        scopeId: sameEndpoint ? previous.scopeId || previous.id : crypto.randomUUID(),
        revision: crypto.randomUUID(),
      };
    });
    res.json({ ok: true });
  });
  app.delete('/api/engines/:id', async (req, res) => {
    await changeConnections((cfg) => {
      cfg.profiles = cfg.profiles.filter((p) => p.id !== req.params.id);
      if (cfg.selected === req.params.id) cfg.selected = 'local';
    });
    res.json({ ok: true });
  });
  app.post('/api/engines/test', async (req, res) => {
    const profile = { ...profileSchema.parse(req.body), id: 'test' };
    res.json(await testConnection(profile));
  });
  app.put('/api/engines/selection/current', async (req, res) => {
    const id = z.string().parse(req.body.id);
    await resolveTarget(id);
    await changeConnections((cfg) => {
      if (id !== 'local' && !cfg.profiles.some((p) => p.id === id))
        throw new Error('연결 프로필을 다시 선택해 주세요.');
      cfg.selected = id;
    });
    res.json({ ok: true });
  });
  app.use('/api', async (req, res, next) => {
    try {
      // Every request resolves once. In-flight requests keep this immutable snapshot.
      const profile = await resolveTarget(req.headers['x-naru-engine'] || 'local');
      if (profile.id !== 'local' && req.headers['x-naru-engine-revision'] !== profile.revision)
        return res
          .status(409)
          .json({ error: '연결 설정이 변경되었습니다. 화면을 새로고침해 주세요.' });
      engineContext.run(profile, () => {
        if (
          remoteTarget() &&
          /^\/(settings|disk|snapshots|kubernetes|kubeconfig|forwards|extensions|diagnostics)(\/|$)/.test(
            req.path,
          )
        )
          return res
            .status(409)
            .json({ error: '로컬 WSL 전용 기능입니다. 로컬 엔진을 선택해 주세요.' });
        if (remoteTarget() && /^\/volumes\/[^/]+\/(files|export|import)(\/|$)/.test(req.path))
          return res
            .status(409)
            .json({ error: '볼륨 파일 탐색과 아카이브는 로컬 WSL 전용입니다.' });
        next();
      });
    } catch (e) {
      next(e);
    }
  });
}
