import assert from 'node:assert/strict';
import test from 'node:test';
import {
  logLines,
  missingEnv,
  randomSecret,
  secretLike,
  shouldExplain,
  stopReason,
} from '../src/container-stop.js';

// 2026-11-25 Naru 엔진에서 실제로 재현한 로그와 상태.
const POSTGRES = `2026-11-25T06:16:17.753700000Z Error: Database is uninitialized and superuser password is not specified.
2026-11-25T06:16:17.753728154Z        You must specify POSTGRES_PASSWORD to a non-empty value for the
2026-11-25T06:16:17.753729729Z        superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".
2026-11-25T06:16:17.753730776Z
2026-11-25T06:16:17.753731526Z        You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all
2026-11-25T06:16:17.753732350Z        connections without a password. This is *not* recommended.`;
const MARIADB = `2026-11-25T06:16:36.102740281Z 2026-11-25 06:16:36+00:00 [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified
2026-11-25T06:16:36.102758892Z 	You need to specify one of MARIADB_ROOT_PASSWORD, MARIADB_ROOT_PASSWORD_HASH, MARIADB_ALLOW_EMPTY_ROOT_PASSWORD and MARIADB_RANDOM_ROOT_PASSWORD`;
const MYSQL = `2026-11-25T06:00:00.000000000Z 2026-11-25 06:00:00+00:00 [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified
2026-11-25T06:00:00.000000001Z     You need to specify one of the following as an environment variable:
2026-11-25T06:00:00.000000002Z     - MYSQL_ROOT_PASSWORD
2026-11-25T06:00:00.000000003Z     - MYSQL_ALLOW_EMPTY_PASSWORD
2026-11-25T06:00:00.000000004Z     - MYSQL_RANDOM_ROOT_PASSWORD`;
const PORT_ERROR =
  'failed to set up container networking: driver failed programming external connectivity on endpoint naru-stop-port (9fe1): Bind for 0.0.0.0:41432 failed: port is already allocated';

const exited = (extra = {}) => ({
  State: {
    Status: 'exited',
    Running: false,
    ExitCode: 1,
    StartedAt: '2026-11-25T06:16:17.000Z',
    FinishedAt: '2026-11-25T06:16:18.000Z',
    ...extra,
  },
  Config: { Env: ['PATH=/usr/bin'] },
  HostConfig: { Memory: 0 },
});

test('바로 오류로 끝났거나 시작이 거부된 컨테이너만 설명한다', () => {
  assert.equal(shouldExplain(exited()), true);
  assert.equal(shouldExplain(exited({ ExitCode: 0 })), false);
  assert.equal(shouldExplain(exited({ FinishedAt: '2026-11-25T07:16:18.000Z' })), false);
  assert.equal(
    shouldExplain(exited({ Status: 'created', ExitCode: 128, Error: PORT_ERROR })),
    true,
  );
  assert.equal(
    shouldExplain(exited({ OOMKilled: true, FinishedAt: '2026-11-26T00:00:00.000Z' })),
    true,
  );
  assert.equal(shouldExplain(exited({ Status: 'running', Running: true })), false);
  assert.equal(shouldExplain(undefined), false);
});

test('로그의 시간과 빈 줄을 덜어 낸다', () => {
  assert.deepEqual(logLines(POSTGRES).slice(0, 2), [
    'Error: Database is uninitialized and superuser password is not specified.',
    '       You must specify POSTGRES_PASSWORD to a non-empty value for the',
  ]);
  assert.equal(logLines('a\nb\nc', 2).join(), 'b,c');
});

test('PostgreSQL: 비밀번호 변수와 trust 대안', () => {
  const reason = stopReason(exited(), POSTGRES);
  assert.equal(reason.kind, 'env');
  assert.equal(reason.name, 'POSTGRES_PASSWORD');
  assert.deepEqual(reason.alternatives, [{ name: 'POSTGRES_HOST_AUTH_METHOD', value: 'trust' }]);
  assert.match(reason.quote, /You must specify POSTGRES_PASSWORD/);
});

test('MariaDB와 MySQL: 비밀번호 변수와 빈 비밀번호, 임의 비밀번호 대안', () => {
  const maria = missingEnv(logLines(MARIADB));
  assert.equal(maria.name, 'MARIADB_ROOT_PASSWORD');
  assert.deepEqual(
    maria.alternatives.map((a) => `${a.name}=${a.value}`),
    ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=yes', 'MARIADB_RANDOM_ROOT_PASSWORD=yes'],
  );
  const mysql = missingEnv(logLines(MYSQL));
  assert.equal(mysql.name, 'MYSQL_ROOT_PASSWORD');
  assert.deepEqual(
    mysql.alternatives.map((a) => a.name),
    ['MYSQL_ALLOW_EMPTY_PASSWORD', 'MYSQL_RANDOM_ROOT_PASSWORD'],
  );
});

test('셸의 ${VAR:?} 검사와 이미 값이 있는 변수', () => {
  assert.equal(
    missingEnv(['/entrypoint.sh: line 4: APP_SECRET: parameter null or not set']).name,
    'APP_SECRET',
  );
  assert.equal(missingEnv(['sh: TOKEN: parameter not set']).name, 'TOKEN');
  assert.equal(missingEnv(logLines(POSTGRES), ['POSTGRES_PASSWORD=x']), null);
  // 값이 빈 변수는 없는 것과 같다.
  assert.equal(missingEnv(logLines(POSTGRES), ['POSTGRES_PASSWORD=']).name, 'POSTGRES_PASSWORD');
  assert.equal(missingEnv(['ERROR something failed', 'NOTE done']), null);
});

test('포트 충돌은 엔진의 시작 거부와 로그 모두에서 읽는다', () => {
  const refused = stopReason(exited({ Status: 'created', ExitCode: 128, Error: PORT_ERROR }), '');
  assert.deepEqual([refused.kind, refused.port], ['port', 41432]);
  const listen = stopReason(
    exited(),
    '2026-11-25T06:00:00Z Error: listen tcp [::]:3000: bind: address already in use',
  );
  assert.deepEqual([listen.kind, listen.port], ['port', 3000]);
});

test('메모리 부족, 시작 거부, 그 밖의 종료', () => {
  assert.equal(stopReason(exited({ OOMKilled: true }), '').kind, 'oom');
  const tail = stopReason(exited(), '2026-11-25T06:16:47.174658885Z tail: out of memory');
  assert.deepEqual([tail.kind, tail.quote], ['oom', 'tail: out of memory']);
  assert.equal(
    stopReason(exited({ Error: 'exec: "nope": executable file not found' }), '').kind,
    'error',
  );
  const other = stopReason(exited({ ExitCode: 2 }), 'a\nb\nfatal: config missing');
  assert.deepEqual(
    [other.kind, other.exitCode, other.quote],
    ['exit', 2, 'a\nb\nfatal: config missing'],
  );
});

test('비밀번호 같은 변수와 임의 값', () => {
  assert.equal(secretLike('POSTGRES_PASSWORD'), true);
  assert.equal(secretLike('API_KEY'), true);
  assert.equal(secretLike('POSTGRES_DB'), false);
  const value = randomSecret(24);
  assert.match(value, /^[A-Za-z0-9]{24}$/);
  assert.notEqual(value, randomSecret(24));
});
