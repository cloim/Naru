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

export function rewriteContainerCreate(body) {
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

// Returns the rewriter for Docker API create calls that carry host paths, otherwise null.
export function createRewriter(method, url) {
  if (method !== 'POST') return null;
  const match = /^(?:\/v[0-9.]+)?\/(containers|volumes)\/create(?:\?|$)/.exec(url);
  if (!match) return null;
  return match[1] === 'containers' ? rewriteContainerCreate : rewriteVolumeCreate;
}
