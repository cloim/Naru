import assert from 'node:assert/strict';
import test from 'node:test';
import { getContainerMounts } from '../src/container-mounts.js';

test('inspect.Mounts 배열이 제공되면 정규화된 마운트 목록을 반환한다', () => {
  const inspect = {
    Mounts: [
      {
        Type: 'bind',
        Source: '/host/specs',
        Destination: '/Specs',
        Mode: 'rw',
        RW: true,
        Propagation: 'rprivate',
      },
      {
        Type: 'volume',
        Name: 'pgdata',
        Source: '/var/lib/docker/volumes/pgdata/_data',
        Destination: '/var/lib/postgresql/data',
        Driver: 'local',
        Mode: 'rw',
        RW: true,
      },
      {
        Type: 'bind',
        Source: '/host/readonly/config',
        Destination: '/etc/config',
        Mode: 'ro',
        RW: false,
      },
    ],
  };

  const mounts = getContainerMounts(inspect);
  assert.equal(mounts.length, 3);

  assert.equal(mounts[0].Type, 'bind');
  assert.equal(mounts[0].Source, '/host/specs');
  assert.equal(mounts[0].Destination, '/Specs');
  assert.equal(mounts[0].RW, true);
  assert.equal(mounts[0].Propagation, 'rprivate');

  assert.equal(mounts[1].Type, 'volume');
  assert.equal(mounts[1].Name, 'pgdata');
  assert.equal(mounts[1].Destination, '/var/lib/postgresql/data');
  assert.equal(mounts[1].RW, true);

  assert.equal(mounts[2].Type, 'bind');
  assert.equal(mounts[2].Destination, '/etc/config');
  assert.equal(mounts[2].RW, false);
});

test('inspect.Mounts가 비어 있고 HostConfig.Binds가 제공되면 바인드 문자열을 파싱한다', () => {
  const inspect = {
    HostConfig: {
      Binds: [
        '/mnt/d/project:/app:rw',
        '/var/log/app:/app/logs:ro',
        'named_vol:/data',
        'C:\\Users\\dev\\project:/workspace:rw',
      ],
    },
  };

  const mounts = getContainerMounts(inspect);
  assert.equal(mounts.length, 4);

  assert.equal(mounts[0].Type, 'bind');
  assert.equal(mounts[0].Source, '/mnt/d/project');
  assert.equal(mounts[0].Destination, '/app');
  assert.equal(mounts[0].RW, true);

  assert.equal(mounts[1].Type, 'bind');
  assert.equal(mounts[1].Source, '/var/log/app');
  assert.equal(mounts[1].Destination, '/app/logs');
  assert.equal(mounts[1].RW, false);

  assert.equal(mounts[2].Type, 'volume');
  assert.equal(mounts[2].Name, 'named_vol');
  assert.equal(mounts[2].Source, 'named_vol');
  assert.equal(mounts[2].Destination, '/data');
  assert.equal(mounts[2].RW, true);

  assert.equal(mounts[3].Type, 'bind');
  assert.equal(mounts[3].Source, 'C:\\Users\\dev\\project');
  assert.equal(mounts[3].Destination, '/workspace');
  assert.equal(mounts[3].RW, true);
});

test('마운트 정보가 없는 inspect이거나 빈 객체일 경우 빈 배열을 반환한다', () => {
  assert.deepEqual(getContainerMounts({}), []);
  assert.deepEqual(getContainerMounts({ Mounts: [] }), []);
  assert.deepEqual(getContainerMounts({ HostConfig: { Binds: [] } }), []);
  assert.deepEqual(getContainerMounts(null), []);
  assert.deepEqual(getContainerMounts(undefined), []);
});
