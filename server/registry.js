import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA, atomicJSON } from './state.js';
import { wsl } from './runner.js';
import { ensureWindowsTool } from './tools.js';
// Docker's dedicated credential helper owns its Windows Credential Manager entries.
// Passwords are passed only on stdin by the login job, never in argv or logs.
export async function ensureCredentialHelper(log) {
  const bin = path.join(DATA, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const dest = await ensureWindowsTool('wincred', log);
  const linux = await wsl(['wslpath', '-a', dest]);
  const script = `#!/bin/sh\nexec '${linux.replace(/'/g, "'\\''")}' "$@"\n`;
  await wsl(
    [
      'sh',
      '-c',
      'cat > /usr/local/bin/docker-credential-naru; chmod 755 /usr/local/bin/docker-credential-naru; mkdir -p /etc/naru/docker',
    ],
    { input: script },
  );
  let config = {};
  try {
    config = JSON.parse(await wsl(['cat', '/etc/naru/docker/config.json']));
  } catch {}
  config.credsStore = 'naru';
  config.auths = config.auths || {};
  await wsl(['sh', '-c', 'umask 077; cat > /etc/naru/docker/config.json'], {
    input: JSON.stringify(config),
  });
  await atomicJSON(path.join(bin, 'credential-helper.json'), {
    helper: 'docker-credential-wincred',
    copiedAt: new Date().toISOString(),
  });
  log('Naru 전용 Docker 설정에 Windows 자격 증명 도우미를 연결했습니다.\n');
}
