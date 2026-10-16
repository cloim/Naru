import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsSchema } from '../server/state.js';
import { assertSharedJob } from '../server/external.js';
test('shared Docker connection validates engine and protects runtime owner', () => {
  assert.equal(settingsSchema.parse({}).connection, 'managed');
  assert.equal(settingsSchema.parse({}).autoStart, true);
  const cfg = settingsSchema.parse({ connection: 'external-engine' });
  assert.equal(cfg.engine, 'moby');
  assert.throws(() =>
    settingsSchema.parse({ connection: 'external-engine', engine: 'containerd' }),
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
