import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedPorts } from '../server/ports.js';

test('IPv4 와일드카드와 루프백 TCP 공개 포트만 중복 없이 고른다', () => {
  const containers = [
    {
      Ports: [
        { IP: '0.0.0.0', PublicPort: 5434, PrivatePort: 5432, Type: 'tcp' },
        { IP: '::', PublicPort: 5434, PrivatePort: 5432, Type: 'tcp' },
        { IP: '127.0.0.1', PublicPort: 6379, PrivatePort: 6379, Type: 'tcp' },
      ],
    },
    {
      Ports: [
        { IP: '0.0.0.0', PublicPort: 5353, PrivatePort: 53, Type: 'udp' },
        { IP: '::', PublicPort: 8443, PrivatePort: 443, Type: 'tcp' },
        { IP: '172.20.0.5', PublicPort: 9000, PrivatePort: 9000, Type: 'tcp' },
        { PrivatePort: 80, Type: 'tcp' },
      ],
    },
    {},
  ];
  assert.deepEqual(publishedPorts(containers), [5434, 6379]);
});
