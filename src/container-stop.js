// 컨테이너가 바로 멈춘 이유를 엔진 정보와 마지막 로그에서 읽는다.
// 추측하지 않는다. 알아본 경우(메모리 부족, 포트 충돌, 빠진 환경 변수)만 이름을 붙이고, 나머지는 로그를 그대로 인용한다.

// 시작 뒤 이 시간 안에 오류로 끝나면 시작하지 못한 것으로 본다.
export const QUICK_SECONDS = 30;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
// 환경 변수 이름: 대문자와 밑줄로 된 낱말. 밑줄이 있어야 ERROR, NOTE 같은 낱말과 구분된다.
const VARIABLE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const NEEDS =
  /(must specify|need to specify|must be set|is required|are required|not specified|is not set|parameter (?:null or )?not set)/i;
const SUGGESTION = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=([A-Za-z0-9_.-]+)/g;

// `docker logs --timestamps`의 줄에서 시간과 빈 줄을 덜어 내고 마지막 `keep`줄을 남긴다.
export function logLines(text, keep = 60) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, '').trimEnd())
    .filter((line) => line.trim());
  return lines.slice(-keep);
}

// 이유를 보여 줄 만큼 이상하게 멈췄는지: 메모리 부족, 시작 거부, 또는 시작 직후 오류 종료.
export function shouldExplain(inspect) {
  const state = inspect?.State;
  if (!state || state.Running || state.Restarting || state.Paused) return false;
  if (!['exited', 'created', 'dead'].includes(state.Status)) return false;
  if (state.OOMKilled || state.Error) return true;
  if (!state.ExitCode) return false;
  const ran = (Date.parse(state.FinishedAt) - Date.parse(state.StartedAt)) / 1000;
  return Number.isFinite(ran) && ran >= 0 && ran <= QUICK_SECONDS;
}

const isSet = (env, name) =>
  env.some((entry) => entry.startsWith(name + '=') && entry.length > name.length + 1);

// 대안 변수에 넣을 값: 빈 비밀번호 허용과 임의 비밀번호 생성은 값이 있기만 하면 된다.
const alternativeValue = (name) => (/ALLOW_EMPTY|RANDOM/.test(name) ? 'yes' : null);

// 로그가 요구하는 환경 변수. 이미 값이 있는 변수는 빼고, 같은 안내에 나온 다른 방법은 대안으로 둔다.
export function missingEnv(lines, env = []) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!NEEDS.test(line)) continue;
    const shell = /\b([A-Za-z_][A-Za-z0-9_]*): parameter (?:null or )?not set/.exec(line);
    const names = shell ? [shell[1]] : [...line.matchAll(VARIABLE)].map((m) => m[0]);
    // "one of the following:" 다음 줄들의 "- NAME" 목록.
    for (let j = i + 1; j < lines.length && /^\s*-\s*[A-Z][A-Z0-9_]+\s*$/.test(lines[j]); j++) {
      names.push(lines[j].trim().slice(1).trim());
    }
    const wanted = [...new Set(names)].filter((name) => !isSet(env, name));
    const primary = wanted.find((name) => !alternativeValue(name) && !/_HASH$|_FILE$/.test(name));
    if (!primary) continue;
    const alternatives = wanted
      .filter((name) => alternativeValue(name))
      .map((name) => ({ name, value: alternativeValue(name) }));
    // 안내 문단에 예로 나온 다른 변수(POSTGRES_HOST_AUTH_METHOD=trust 같은)도 대안이다.
    for (const later of lines.slice(i, i + 8)) {
      for (const [, name, value] of later.matchAll(SUGGESTION)) {
        if (name !== primary && !alternatives.some((a) => a.name === name) && !isSet(env, name)) {
          alternatives.push({ name, value });
        }
      }
    }
    // 안내 문장이 다음 줄로 이어지는 경우가 많아(PostgreSQL) 두 줄을 인용한다.
    const quote = lines
      .slice(i, i + 2)
      .map((l) => l.trim())
      .join('\n');
    return { name: primary, alternatives, quote };
  }
  return null;
}

const PORT =
  /(?:\]|\b)[:](\d{1,5})(?: failed: port is already allocated|: bind: address already in use)/i;

// 멈춘 이유. kind: oom(메모리 부족) | port(포트 충돌) | env(빠진 환경 변수) | error(시작 거부) | exit(그 밖의 종료)
export function stopReason(inspect, logText) {
  const state = inspect?.State || {};
  const lines = logLines(logText);
  const memory = inspect?.HostConfig?.Memory || 0;
  if (state.OOMKilled) return { kind: 'oom', memory, quote: '' };
  const portLine = [state.Error || '', ...lines].find((line) => PORT.test(line));
  if (portLine)
    return { kind: 'port', port: Number(PORT.exec(portLine)[1]), quote: portLine.trim() };
  const env = missingEnv(lines, inspect?.Config?.Env || []);
  if (env) return { kind: 'env', ...env };
  const memoryLine = lines.find((line) => /out of memory|cannot allocate memory/i.test(line));
  if (memoryLine && state.ExitCode) return { kind: 'oom', memory, quote: memoryLine.trim() };
  if (state.Error) return { kind: 'error', quote: state.Error };
  return { kind: 'exit', exitCode: state.ExitCode, quote: lines.slice(-6).join('\n') };
}

// 비밀번호처럼 보이는 변수: 값을 만들어 주는 버튼을 보여 준다.
export const secretLike = (name) => /PASSWORD|SECRET|TOKEN|_KEY\b|PASSPHRASE/.test(name);

// 영문 대소문자와 숫자로 된 임의 값. 기호를 넣지 않아 접속 주소나 셸에 그대로 쓸 수 있다.
export function randomSecret(
  length = 24,
  random = (n) => crypto.getRandomValues(new Uint8Array(n)),
) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      // 256을 글자 수로 나눌 때 남는 값은 버려 고르게 뽑는다.
      if (byte < 256 - (256 % chars.length) && out.length < length)
        out += chars[byte % chars.length];
    }
  }
  return out;
}
