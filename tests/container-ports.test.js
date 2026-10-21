import assert from 'node:assert/strict';
import test from 'node:test';
import { publicPortMappings } from '../src/container-ports.js';

test('IP별 바인딩을 통합하고 원본 상세 정보는 보존한다', () => {
  const ipv4 = Object.freeze({ IP: '0.0.0.0', PublicPort: 5434, PrivatePort: 5432, Type: 'tcp' });
  const ipv6 = Object.freeze({ ...ipv4, IP: '::' });
  const ports = Object.freeze([ipv4, ipv6]);
  assert.deepEqual(publicPortMappings(ports), [ipv4]);
  assert.deepEqual(ports, [ipv4, ipv6]);
});

test('서로 다른 호스트 포트, 컨테이너 포트, 프로토콜은 유지한다', () => {
  const ports = [
    { PublicPort: 8080, PrivatePort: 80, Type: 'tcp' },
    { PublicPort: 8081, PrivatePort: 80, Type: 'tcp' },
    { PublicPort: 8080, PrivatePort: 81, Type: 'tcp' },
    { PublicPort: 8080, PrivatePort: 80, Type: 'udp' },
  ];
  assert.deepEqual(publicPortMappings(ports), ports);
});

test('공개 포트가 없는 항목과 빈 목록을 처리한다', () => {
  assert.deepEqual(publicPortMappings([{ PrivatePort: 9600, Type: 'tcp' }]), []);
  assert.deepEqual(publicPortMappings([]), []);
  assert.deepEqual(publicPortMappings(), []);
});
