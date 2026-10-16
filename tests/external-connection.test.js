import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsSchema } from '../server/state.js';
import { assertSharedJob } from '../server/external.js';
test('shared Docker connection validates engine and protects runtime owner', () => {
  assert.equal(settingsSchema.parse({}).connection, 'managed');
  assert.equal(settingsSchema.parse({}).autoStart, true);
  const cfg = settingsSchema.parse({ connection: 'rancher-desktop' });
  assert.equal(cfg.engine, 'moby');
  assert.throws(() =>
    settingsSchema.parse({ connection: 'rancher-desktop', engine: 'containerd' }),
  );
  for (const type of [
    'startRuntime',
    'stopRuntime',
    'installRuntime',
    'startKubernetes',
    'stopKubernetes',
    'snapshot',
    'restoreSnapshot',
    'deleteSnapshot',
    'installExtension',
    'createForward',
  ])
    assert.throws(() => assertSharedJob(type, cfg));
  for (const type of [
    'createContainer',
    'containerAction',
    'createVolume',
    'buildImage',
    'compose',
    'exportImage',
    'registryLogin',
    'installCLI',
  ])
    assert.doesNotThrow(() => assertSharedJob(type, cfg));
  assert.doesNotThrow(() => assertSharedJob('stopRuntime', { connection: 'managed' }));
});

test('only screen and startup settings may change while the engine runs', async () => {
  const { engineSettingsChanged } = await import('../server/state.js');
  const base = settingsSchema.parse({});
  assert.equal(engineSettingsChanged(base, { ...base, pollSeconds: 10, autoStart: false }), false);
  assert.equal(engineSettingsChanged(base, { ...base, engine: 'containerd' }), true);
  assert.equal(
    engineSettingsChanged(base, { ...base, proxy: { ...base.proxy, http: 'http://proxy:3128' } }),
    true,
  );
});
