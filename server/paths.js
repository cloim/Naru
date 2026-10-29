// Windows clients send host paths such as D:\work\app; the Linux engine sees drives under /mnt.
const DRIVE = /^([a-zA-Z]):(?:[\\/](.*))?$/s;

export function toLinuxPath(value) {
  const match = typeof value === 'string' && DRIVE.exec(value);
  if (!match) return value;
  const rest = (match[2] || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${match[1].toLowerCase()}${rest ? '/' + rest : ''}`;
}

// A bind is "source:target[:options]"; a drive source carries its own colon.
export function rewriteBind(bind) {
  if (typeof bind !== 'string' || !/^[a-zA-Z]:[\\/]/.test(bind)) return bind;
  const end = bind.indexOf(':', 2);
  return end < 0 ? toLinuxPath(bind) : toLinuxPath(bind.slice(0, end)) + bind.slice(end);
}

// The same variables the Docker CLI adds from its proxies config; values the client set win.
export function proxyEnv(proxies) {
  if (!proxies) return [];
  const pairs = [
    ['HTTP_PROXY', proxies.httpProxy],
    ['HTTPS_PROXY', proxies.httpsProxy],
    ['NO_PROXY', proxies.noProxy],
  ].filter(([, value]) => value);
  return pairs.flatMap(([key, value]) => [`${key}=${value}`, `${key.toLowerCase()}=${value}`]);
}

function addMissing(list, entries) {
  const keys = new Set(list.map((entry) => entry.split('=')[0]));
  return [...list, ...entries.filter((entry) => !keys.has(entry.split('=')[0]))];
}

export function rewriteContainerCreate(body, proxies) {
  const env = proxyEnv(proxies);
  if (body && env.length) body.Env = addMissing(Array.isArray(body.Env) ? body.Env : [], env);
  const host = body?.HostConfig;
  if (!host) return body;
  if (Array.isArray(host.Binds)) host.Binds = host.Binds.map(rewriteBind);
  if (Array.isArray(host.Mounts))
    for (const mount of host.Mounts)
      if (mount?.Type === 'bind') mount.Source = toLinuxPath(mount.Source);
  return body;
}

export function rewriteVolumeCreate(body) {
  const options = body?.DriverOpts;
  if (options?.device && /\bbind\b/.test(options.o || ''))
    options.device = toLinuxPath(options.device);
  return body;
}

// Builds receive proxies as build args, as the Docker CLI does.
export function rewriteBuildUrl(url, proxies) {
  const env = proxyEnv(proxies);
  if (!env.length || !/^(?:\/v[0-9.]+)?\/build(?:\?|$)/.test(url)) return url;
  const parsed = new URL(url, 'http://docker');
  const args = JSON.parse(parsed.searchParams.get('buildargs') || '{}');
  for (const entry of env) {
    const index = entry.indexOf('=');
    args[entry.slice(0, index)] ??= entry.slice(index + 1);
  }
  parsed.searchParams.set('buildargs', JSON.stringify(args));
  return parsed.pathname + parsed.search;
}

// Returns the rewriter for Docker API create calls that carry host paths, otherwise null.
export function createRewriter(method, url) {
  if (method !== 'POST') return null;
  const match = /^(?:\/v[0-9.]+)?\/(containers|volumes)\/create(?:\?|$)/.exec(url);
  if (!match) return null;
  return match[1] === 'containers' ? rewriteContainerCreate : rewriteVolumeCreate;
}
