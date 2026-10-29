import assert from 'node:assert/strict';
import test from 'node:test';
import { containerProxyConfig } from '../server/state.js';
import { rewriteBuildUrl, rewriteContainerCreate } from '../server/paths.js';

test('Windows localhost 프록시는 host.docker.internal로 바꾼다', () => {
  assert.equal(containerProxyConfig({ http: '', https: '', noProxy: 'localhost' }), null);
  assert.deepEqual(
    containerProxyConfig({
      http: 'http://user:pw@127.0.0.1:3128',
      https: 'localhost:3129',
      noProxy: 'localhost,.svc',
    }),
    {
      httpProxy: 'http://user:pw@host.docker.internal:3128',
      httpsProxy: 'host.docker.internal:3129',
      noProxy: 'localhost,.svc',
    },
  );
  assert.equal(
    containerProxyConfig({ http: 'http://proxy.example.com:8080', https: '', noProxy: '' })
      .httpProxy,
    'http://proxy.example.com:8080',
  );
});

test('컨테이너 생성과 빌드에 클라이언트가 정하지 않은 프록시만 추가한다', () => {
  const proxies = { httpProxy: 'http://p:1', noProxy: 'localhost' };
  const body = rewriteContainerCreate({ Env: ['HTTP_PROXY=http://mine:2'] }, proxies);
  assert.deepEqual(body.Env, [
    'HTTP_PROXY=http://mine:2',
    'http_proxy=http://p:1',
    'NO_PROXY=localhost',
    'no_proxy=localhost',
  ]);
  assert.deepEqual(rewriteContainerCreate({ Image: 'a' }, null), { Image: 'a' });
  const url = rewriteBuildUrl(
    '/v1.47/build?t=app&buildargs=%7B%22no_proxy%22%3A%22x%22%7D',
    proxies,
  );
  assert.deepEqual(JSON.parse(new URL(url, 'http://d').searchParams.get('buildargs')), {
    no_proxy: 'x',
    HTTP_PROXY: 'http://p:1',
    http_proxy: 'http://p:1',
    NO_PROXY: 'localhost',
  });
  assert.equal(rewriteBuildUrl('/v1.47/containers/json', proxies), '/v1.47/containers/json');
  assert.equal(rewriteBuildUrl('/build?t=a', null), '/build?t=a');
});
