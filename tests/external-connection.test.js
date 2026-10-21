import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsSchema } from '../server/state.js';

test('settingsSchema validates defaults and types', () => {
  assert.equal(settingsSchema.parse({}).connection, 'managed');
  assert.equal(settingsSchema.parse({}).autoStart, true);
  assert.equal(settingsSchema.parse({}).engine, 'moby');
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
