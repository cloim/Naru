import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toLinuxPath,
  rewriteBind,
  rewriteContainerCreate,
  rewriteVolumeCreate,
  createRewriter,
} from '../server/paths.js';

test('Windows drive paths map to WSL mounts', () => {
  assert.equal(toLinuxPath('D:\\PROJECTS\\sample-app\\db'), '/mnt/d/PROJECTS/sample-app/db');
  assert.equal(toLinuxPath('c:/Users/me/'), '/mnt/c/Users/me');
  assert.equal(toLinuxPath('E:\\'), '/mnt/e');
  assert.equal(toLinuxPath('/mnt/d/x'), '/mnt/d/x');
  assert.equal(toLinuxPath('named-volume'), 'named-volume');
});

test('bind strings keep target and options', () => {
  assert.equal(
    rewriteBind('D:\\PROJECTS\\sample-app\\db\\init.sql:/docker-entrypoint-initdb.d/init.sql:ro'),
    '/mnt/d/PROJECTS/sample-app/db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro',
  );
  assert.equal(rewriteBind('pgdata:/var/lib/postgresql/data'), 'pgdata:/var/lib/postgresql/data');
  assert.equal(rewriteBind('/mnt/d/a:/a'), '/mnt/d/a:/a');
});

test('container and volume create bodies are rewritten only for host paths', () => {
  const body = rewriteContainerCreate({
    HostConfig: {
      Binds: ['C:\\data:/data'],
      Mounts: [
        { Type: 'bind', Source: 'D:\\app', Target: '/app' },
        { Type: 'volume', Source: 'D:cache', Target: '/cache' },
      ],
    },
  });
  assert.deepEqual(body.HostConfig.Binds, ['/mnt/c/data:/data']);
  assert.equal(body.HostConfig.Mounts[0].Source, '/mnt/d/app');
  assert.equal(body.HostConfig.Mounts[1].Source, 'D:cache');
  assert.equal(
    rewriteVolumeCreate({ DriverOpts: { type: 'none', o: 'bind', device: 'D:\\share' } }).DriverOpts
      .device,
    '/mnt/d/share',
  );
  assert.equal(
    rewriteVolumeCreate({ DriverOpts: { type: 'nfs', o: 'addr=1.2.3.4', device: 'D:\\x' } })
      .DriverOpts.device,
    'D:\\x',
  );
});

test('only create endpoints are rewritten', () => {
  assert.equal(createRewriter('POST', '/v1.47/containers/create?name=web'), rewriteContainerCreate);
  assert.equal(createRewriter('POST', '/volumes/create'), rewriteVolumeCreate);
  assert.equal(createRewriter('GET', '/v1.47/containers/create'), null);
  assert.equal(createRewriter('POST', '/v1.47/containers/abc/start'), null);
});
