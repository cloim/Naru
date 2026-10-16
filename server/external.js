import http from 'node:http';
export const RANCHER_PIPE = '\\\\.\\pipe\\docker_engine';
export const RANCHER_HOST = 'npipe:////./pipe/docker_engine';
export function rancherRequest(route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: RANCHER_PIPE, path: route }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode >= 400)
          return reject(Error('Rancher Desktop Docker 응답: ' + res.statusCode));
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.setTimeout(3000, () =>
      req.destroy(Error('Rancher Desktop의 Docker 엔진 응답을 확인해 주세요.')),
    );
    req.on('error', reject);
  });
}
export async function requireManaged() {
  const { settings } = await import('./state.js');
  if ((await settings()).connection === 'rancher-desktop')
    throw Error('공유 엔진의 실행 환경은 Rancher Desktop에서 관리합니다.');
}

export function assertSharedJob(type, cfg) {
  if (
    cfg.connection === 'rancher-desktop' &&
    !new Set([
      'installCLI',
      'containerAction',
      'createContainer',
      'pullImage',
      'pushImage',
      'removeImage',
      'tagImage',
      'createVolume',
      'removeVolume',
      'createNetwork',
      'removeNetwork',
      'buildImage',
      'exportImage',
      'importImage',
      'compose',
      'project',
      'registryLogin',
      'registryLogout',
    ]).has(type)
  )
    throw Error(
      '공유 모드에서는 컨테이너와 이미지를 관리합니다. 런타임, Kubernetes와 확장은 Rancher Desktop에서 관리해 주세요.',
    );
}
