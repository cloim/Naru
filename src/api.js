let token;
let binding;
let bindingLoad;
async function parseJson(response) {
  const text = await response.text();
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export const isRemoteEngine = () => binding?.id && binding.id !== 'local';
export const engineStorageKey = (key) =>
  binding && binding.id !== 'local' ? `${key}.${binding.scopeId || binding.id}` : key;
export async function engineBinding() {
  if (!bindingLoad)
    bindingLoad = (async () => {
      if (globalThis.__setBootStatus) globalThis.__setBootStatus('엔진 목록 조회 중...');
      const response = await fetch('/api/engines', { headers: { 'X-Naru-Token': token } });
      const cfg = await parseJson(response);
      if (!response.ok) {
        throw new Error(cfg.error || '연결 프로필을 조회할 수 없습니다.');
      }
      const id = cfg.selected;
      binding = id === 'local' ? { id, name: '로컬 WSL' } : cfg.profiles?.find((p) => p.id === id);
      if (!binding) throw new Error('연결 대상을 다시 선택해 주세요.');
      if (globalThis.__setBootStatus) globalThis.__setBootStatus(`엔진 선택됨: ${binding.name}`);
      return binding;
    })().catch((e) => {
      bindingLoad = null;
      if (globalThis.__setBootStatus) globalThis.__setBootStatus(`엔진 조회 오류: ${e.message}`, true);
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
  if (!token) {
    if (globalThis.__setBootStatus) globalThis.__setBootStatus('세션 토큰 요청 중...');
    const sessionRes = await fetch('/api/session');
    const sessionData = await parseJson(sessionRes);
    if (!sessionRes.ok || !sessionData.token) {
      const err =
        sessionData.error ||
        `세션 토큰 요청 실패 (HTTP ${sessionRes.status}). 백엔드 서버(49170) 실행 상태를 확인해 주세요.`;
      if (globalThis.__setBootStatus) globalThis.__setBootStatus(err, true);
      throw new Error(err);
    }
    token = sessionData.token;
  }
  if (!route.startsWith('/engines')) await engineBinding();
  if (globalThis.__setBootStatus) globalThis.__setBootStatus(`API 요청: ${route}`);
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
  const json = await parseJson(response);
  if (!response.ok) {
    const err = json.error || `HTTP ${response.status}`;
    if (globalThis.__setBootStatus) globalThis.__setBootStatus(`API 오류 (${route}): ${err}`, true);
    throw new Error(err);
  }
  return json;
}
export async function downloadConfig() {
  if (!token) await api('/settings');
  const r = await fetch('/api/kubeconfig', {
    headers: { 'X-Naru-Token': token, ...engineHeaders() },
  });
  if (!r.ok) {
    const data = await parseJson(r);
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'naru-kubeconfig.yaml';
  a.click();
  URL.revokeObjectURL(url);
}
