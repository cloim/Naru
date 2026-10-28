let token;
let binding;
let bindingLoad;
export const isRemoteEngine = () => binding?.id && binding.id !== 'local';
export const engineStorageKey = (key) =>
  binding && binding.id !== 'local' ? `${key}.${binding.scopeId || binding.id}` : key;
export async function engineBinding() {
  if (!bindingLoad)
    bindingLoad = (async () => {
      const response = await fetch('/api/engines', { headers: { 'X-Naru-Token': token } });
      if (!response.ok) throw new Error('연결 프로필을 조회할 수 없습니다.');
      const cfg = await response.json();
      const id = cfg.selected;
      binding = id === 'local' ? { id, name: '로컬 WSL' } : cfg.profiles.find((p) => p.id === id);
      if (!binding) throw new Error('연결 대상을 다시 선택해 주세요.');
      return binding;
    })().catch((e) => {
      bindingLoad = null;
      throw e;
    });
  return bindingLoad;
}
export function engineHeaders() {
  return {
    'X-Naru-Engine': binding?.id || 'local',
    'X-Naru-Engine-Revision': binding?.revision || '',
  };
}
export async function api(route, options = {}, renewed = false) {
  if (!token) token = (await fetch('/api/session').then((r) => r.json())).token;
  if (!route.startsWith('/engines')) await engineBinding();
  const response = await fetch('/api' + route, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Naru-Token': token,
      ...engineHeaders(),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  // 서버가 재시작되면 세션 토큰이 바뀐다. 새로고침 없이 이어지도록 토큰을 한 번 다시 받아 재시도한다.
  if (response.status === 401 && !renewed) {
    token = null;
    return api(route, options, true);
  }
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}
export async function downloadConfig() {
  if (!token) await api('/settings');
  const r = await fetch('/api/kubeconfig', {
    headers: { 'X-Naru-Token': token, ...engineHeaders() },
  });
  if (!r.ok) throw new Error((await r.json()).error);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'naru-kubeconfig.yaml';
  a.click();
  URL.revokeObjectURL(url);
}
