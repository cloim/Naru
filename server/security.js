import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Remote access is off unless remote.json names the Tailscale serve host and the tailnet logins allowed to use it.
export function loadRemote(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const host = String(raw?.host || '')
      .trim()
      .toLowerCase(),
    users = new Set(
      (Array.isArray(raw?.users) ? raw.users : [])
        .map((u) => String(u).trim().toLowerCase())
        .filter(Boolean),
    );
  return /^[a-z0-9.-]+\.ts\.net(:\d{1,5})?$/.test(host) && users.size ? { host, users } : null;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Returns the page scheme for an allowed request, or null. Remote requests must arrive through `tailscale serve`,
// which connects from loopback and replaces any client-supplied Tailscale-User-Login with the verified tailnet login.
export function access(req, port, remote) {
  const headers = req.headers,
    origin = headers.origin;
  if (new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(headers.host))
    return !origin || new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin)
      ? 'http'
      : null;
  if (
    remote &&
    String(headers.host || '').toLowerCase() === remote.host &&
    LOOPBACK.has(req.socket?.remoteAddress) &&
    remote.users.has(String(headers['tailscale-user-login'] || '').toLowerCase()) &&
    (!origin || origin.toLowerCase() === `https://${remote.host}`)
  )
    return 'https';
  return null;
}

export function security(port, token, remote = null) {
  return (req, res, next) => {
    if (!access(req, port, remote))
      return res.status(403).json({ error: '허용되지 않은 Host 또는 출처입니다.' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return res.status(403).json({ error: '다른 사이트의 요청은 허용되지 않습니다.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/') && req.path !== '/api/session') {
      const supplied = Buffer.from(String(req.headers['x-naru-token'] || '')),
        expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return res.status(401).json({ error: '페이지를 새로고침해 연결을 갱신해 주세요.' });
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}
