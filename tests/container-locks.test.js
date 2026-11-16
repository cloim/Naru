import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isContainerLocked,
  getContainerLockTargets,
  getProjectLockTargets,
  isProjectLocked,
} from '../src/container-locks.js';

test('isContainerLocked matches full ID and short ID', () => {
  const locks = new Set(['c1234567890a', 'exact-full-id']);
  const c1 = { Id: 'exact-full-id' };
  const c2 = { Id: 'c1234567890a1234567890' }; // matched by short ID prefix (first 12 chars)
  const c3 = { Id: 'other1234567890' };

  assert.equal(isContainerLocked(locks, c1), true);
  assert.equal(isContainerLocked(locks, c2), true);
  assert.equal(isContainerLocked(locks, c3), false);
});

test('isContainerLocked matches container names with and without slash', () => {
  const locks = new Set(['my-nginx']);
  const c1 = { Id: '999999999999', Names: ['/my-nginx'] };
  const c2 = { Id: '888888888888', Names: ['/other-nginx'] };

  assert.equal(isContainerLocked(locks, c1), true);
  assert.equal(isContainerLocked(locks, c2), false);
});

test('isContainerLocked matches compose project label', () => {
  const locks = new Set(['project:demo']);
  const c1 = {
    Id: '111111111111',
    Names: ['/demo-web-1'],
    Labels: { 'com.docker.compose.project': 'demo' },
  };
  const c2 = {
    Id: '222222222222',
    Names: ['/demo-db-1'],
    Config: { Labels: { 'com.docker.compose.project': 'demo' } },
  };
  const c3 = {
    Id: '333333333333',
    Names: ['/standalone-app'],
  };

  assert.equal(isContainerLocked(locks, c1), true);
  assert.equal(isContainerLocked(locks, c2), true);
  assert.equal(isContainerLocked(locks, c3), false);
});

test('isProjectLocked checks project key and member containers', () => {
  const locks1 = new Set(['project:cool-app']);
  assert.equal(isProjectLocked(locks1, 'cool-app', []), true);

  const locks2 = new Set(['c1', 'c2']);
  const members = [{ Id: 'c1' }, { Id: 'c2' }];
  assert.equal(isProjectLocked(locks2, 'cool-app', members), true);

  const membersPartial = [{ Id: 'c1' }, { Id: 'c3' }];
  assert.equal(isProjectLocked(locks2, 'cool-app', membersPartial), false);
});

test('getContainerLockTargets and getProjectLockTargets collect identifiers', () => {
  const c = {
    Id: 'abcdef1234567890',
    Names: ['/my-service-1'],
  };
  const targets = getContainerLockTargets(c);
  assert.ok(targets.includes('abcdef1234567890'));
  assert.ok(targets.includes('abcdef123456'));
  assert.ok(targets.includes('my-service-1'));

  const projTargets = getProjectLockTargets('my-proj', [c]);
  assert.ok(projTargets.includes('project:my-proj'));
  assert.ok(projTargets.includes('my-proj'));
  assert.ok(projTargets.includes('my-service-1'));
});
