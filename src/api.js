let token;
export async function api(route, options = {}) {
  if (!token) token = (await fetch('/api/session').then((r) => r.json())).token;
  const response = await fetch('/api' + route, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Naru-Token': token, ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}
export async function downloadConfig() {
  if (!token) await api('/settings');
  const r = await fetch('/api/kubeconfig', { headers: { 'X-Naru-Token': token } });
  if (!r.ok) throw new Error((await r.json()).error);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'naru-kubeconfig.yaml';
  a.click();
  URL.revokeObjectURL(url);
}
