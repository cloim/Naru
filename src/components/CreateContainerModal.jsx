import { engineStorageKey } from '../api.js';
import { t, useLocale } from '../i18n.js';
import React, { useState, useEffect, useMemo } from 'react';
import {
  Terminal,
  Bookmark,
  ClipboardPaste,
  Plus,
  Trash2,
  Check,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import { Modal } from './Modal/Modal.jsx';
import { Button, CopyButton } from '../ui.jsx';
import { tw, cn } from '../tw.js';

export const CONTAINER_TEMPLATES = [
  {
    name: 'Nginx',
    image: 'nginx:alpine',
    defaultName: 'my-nginx',
    ports: '8080:80',
    env: '',
    mounts: '',
    command: '',
  },
  {
    name: 'Redis',
    image: 'redis:alpine',
    defaultName: 'my-redis',
    ports: '6379:6379',
    env: '',
    mounts: '',
    command: '',
  },
  {
    name: 'PostgreSQL',
    image: 'postgres:alpine',
    defaultName: 'my-postgres',
    ports: '5432:5432',
    env: 'POSTGRES_PASSWORD=postgres\nPOSTGRES_DB=mydb',
    mounts: 'pgdata:/var/lib/postgresql/data',
    command: '',
  },
  {
    name: 'MySQL',
    image: 'mysql:8',
    defaultName: 'my-mysql',
    ports: '3306:3306',
    env: 'MYSQL_ROOT_PASSWORD=root\nMYSQL_DATABASE=mydb',
    mounts: 'mysqldata:/var/lib/mysql',
    command: '',
  },
  {
    name: 'Node.js',
    image: 'node:20-alpine',
    defaultName: 'my-node',
    ports: '3000:3000',
    env: 'NODE_ENV=development',
    mounts: '',
    command: 'sleep infinity',
  },
  {
    name: 'Ubuntu',
    image: 'ubuntu:22.04',
    defaultName: 'my-ubuntu',
    ports: '',
    env: '',
    mounts: '',
    command: 'sleep infinity',
  },
];

export const DEFAULT_ENV_PRESETS = [
  { name: 'Node.js (Dev)', env: 'NODE_ENV=development\nPORT=3000' },
  {
    name: 'PostgreSQL',
    env: 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=postgres\nPOSTGRES_DB=mydb',
  },
  { name: 'Redis', env: 'REDIS_PASSWORD=secret\nALLOW_EMPTY_PASSWORD=yes' },
  { name: 'Python (Django)', env: 'PYTHONUNBUFFERED=1\nDEBUG=True' },
  { name: 'Spring Boot', env: 'SPRING_PROFILES_ACTIVE=dev\nSERVER_PORT=8080' },
];

const PRESETS_STORAGE_KEY = 'naru.envPresets';

function readCustomPresets() {
  try {
    return JSON.parse(localStorage.getItem(engineStorageKey(PRESETS_STORAGE_KEY)) || '[]');
  } catch {
    return [];
  }
}

export function parseMountsInput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error(t('볼륨 마운트 JSON 배열 형식이 아닙니다.'));
    return parsed;
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-zA-Z]:[\\/][^:]+|[^:]+):([^:]+)(?::([^:]+))?$/);
      if (!match)
        throw new Error(t('볼륨 마운트 형식(source:target)이 올바르지 않습니다: {0}', [line]));
      const [, source, target, mode] = match;
      return {
        source: source.trim(),
        target: target.trim(),
        readOnly: mode?.trim().toLowerCase() === 'ro',
      };
    });
}

export function parseCommandInput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error(t('실행 인수 JSON 배열 형식이 아닙니다.'));
    return parsed;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

export function parsePortsInput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  return trimmed
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const parts = x.split(':');
      if (parts.length !== 2) {
        throw new Error(t('포트 형식(호스트포트:컨테이너포트)이 올바르지 않습니다: {0}', [x]));
      }
      const host = Number(parts[0]);
      const container = Number(parts[1]);
      if (!Number.isInteger(host) || !Number.isInteger(container)) {
        throw new Error(t('포트 번호는 정수여야 합니다: {0}', [x]));
      }
      return { host, container, protocol: 'tcp' };
    });
}

export function parseDockerRunCommand(str) {
  const trimmed = (str || '').trim();
  if (!trimmed) return null;
  const tokens = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    tokens.push(match[1] || match[2] || match[0]);
  }
  if (!tokens.length) return null;
  let i = 0;
  if (tokens[i] === 'docker') i++;
  if (tokens[i] === 'container') i++;
  if (tokens[i] === 'run') i++;

  let name = '';
  const portList = [];
  const envList = [];
  const mountList = [];
  let image = '';
  const cmdTokens = [];

  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--name' && i + 1 < tokens.length) {
      name = tokens[++i];
    } else if (t.startsWith('--name=')) {
      name = t.slice(7);
    } else if ((t === '-p' || t === '--publish') && i + 1 < tokens.length) {
      portList.push(tokens[++i]);
    } else if (t.startsWith('-p=')) {
      portList.push(t.slice(3));
    } else if (t.startsWith('--publish=')) {
      portList.push(t.slice(10));
    } else if ((t === '-e' || t === '--env') && i + 1 < tokens.length) {
      envList.push(tokens[++i]);
    } else if (t.startsWith('-e=')) {
      envList.push(t.slice(3));
    } else if (t.startsWith('--env=')) {
      envList.push(t.slice(6));
    } else if ((t === '-v' || t === '--volume') && i + 1 < tokens.length) {
      mountList.push(tokens[++i]);
    } else if (t.startsWith('-v=')) {
      mountList.push(t.slice(3));
    } else if (t.startsWith('--volume=')) {
      mountList.push(t.slice(9));
    } else if (t.startsWith('-')) {
      if (
        ['--restart', '-w', '--workdir', '-u', '--user', '--network', '--entrypoint'].includes(t)
      ) {
        i++;
      }
    } else {
      image = t;
      i++;
      while (i < tokens.length) {
        cmdTokens.push(tokens[i++]);
      }
      break;
    }
    i++;
  }

  return {
    image,
    name,
    ports: portList.join(', '),
    env: envList.join('\n'),
    mounts: mountList.join('\n'),
    command: cmdTokens.join(' '),
  };
}

export function generateDockerRunCommand({ image, name, ports, env, mounts, command }) {
  const parts = ['docker run -d'];
  if (name?.trim()) parts.push(`--name ${name.trim()}`);
  if (ports?.trim()) {
    ports
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((p) => parts.push(`-p ${p}`));
  }
  if (env?.trim()) {
    env
      .split('\n')
      .map((e) => e.trim())
      .filter(Boolean)
      .forEach((e) => parts.push(`-e "${e}"`));
  }
  if (mounts?.trim()) {
    mounts
      .split('\n')
      .map((m) => m.trim())
      .filter(Boolean)
      .forEach((m) => parts.push(`-v "${m}"`));
  }
  parts.push(image?.trim() || '<image>');
  if (command?.trim()) parts.push(command.trim());
  return parts.join(' ');
}

export function CreateContainerModal({ isOpen, onClose, onSubmit, busy, initialValues }) {
  useLocale();
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [ports, setPorts] = useState('');
  const [env, setEnv] = useState('');
  const [mounts, setMounts] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');

  const [showCliInput, setShowCliInput] = useState(false);
  const [cliInput, setCliInput] = useState('');
  const [showEnvPresets, setShowEnvPresets] = useState(false);
  const [customPresets, setCustomPresets] = useState(readCustomPresets);
  const [newPresetName, setNewPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);

  useEffect(() => {
    if (initialValues) {
      setImage(initialValues.image || '');
      setName(initialValues.name || '');
      setPorts(initialValues.ports || '');
      setEnv(initialValues.env || '');
      setMounts(initialValues.mounts || '');
      setCommand(initialValues.command || '');
      setError('');
    } else if (isOpen) {
      setImage('');
      setName('');
      setPorts('');
      setEnv('');
      setMounts('');
      setCommand('');
      setError('');
      setShowCliInput(false);
      setCliInput('');
      setShowEnvPresets(false);
    }
  }, [initialValues, isOpen]);

  const applyTemplate = (tpl) => {
    setImage(tpl.image);
    setName(tpl.defaultName);
    setPorts(tpl.ports);
    setEnv(tpl.env);
    setMounts(tpl.mounts);
    setCommand(tpl.command);
    setError('');
  };

  const applyCliCommand = () => {
    const parsed = parseDockerRunCommand(cliInput);
    if (!parsed || !parsed.image) {
      setError(t('올바른 docker run 명령어를 입력해 주세요.'));
      return;
    }
    if (parsed.image) setImage(parsed.image);
    if (parsed.name) setName(parsed.name);
    if (parsed.ports) setPorts(parsed.ports);
    if (parsed.env) setEnv(parsed.env);
    if (parsed.mounts) setMounts(parsed.mounts);
    if (parsed.command) setCommand(parsed.command);
    setShowCliInput(false);
    setCliInput('');
    setError('');
  };

  const handleApplyPreset = (presetEnv) => {
    setEnv((prev) => (prev ? `${prev}\n${presetEnv}` : presetEnv));
    setShowEnvPresets(false);
  };

  const handleSaveCustomPreset = () => {
    if (!newPresetName.trim() || !env.trim()) return;
    const updated = [...customPresets, { name: newPresetName.trim(), env: env.trim() }];
    setCustomPresets(updated);
    try {
      localStorage.setItem(engineStorageKey(PRESETS_STORAGE_KEY), JSON.stringify(updated));
    } catch {}
    setNewPresetName('');
    setSavingPreset(false);
  };

  const handleDeleteCustomPreset = (nameToDelete) => {
    const updated = customPresets.filter((p) => p.name !== nameToDelete);
    setCustomPresets(updated);
    try {
      localStorage.setItem(engineStorageKey(PRESETS_STORAGE_KEY), JSON.stringify(updated));
    } catch {}
  };

  const generatedCliCommand = useMemo(() => {
    return generateDockerRunCommand({ image, name, ports, env, mounts, command });
  }, [image, name, ports, env, mounts, command]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (!image.trim()) {
        throw new Error(t('이미지 이름을 입력해 주세요.'));
      }
      const parsedPorts = parsePortsInput(ports);
      const parsedMounts = parseMountsInput(mounts);
      const parsedCommand = parseCommandInput(command);
      const envList = env
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);

      await onSubmit({
        image: image.trim(),
        name: name.trim() || undefined,
        ports: parsedPorts,
        env: envList,
        mounts: parsedMounts,
        command: parsedCommand,
      });
    } catch (err) {
      setError(err.message || String(err));
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen
      onClose={busy ? undefined : onClose}
      closeOnEscape={!busy}
      closeOnOverlayClick={!busy}
      title={t('컨테이너 실행')}
      size="lg"
      storageKey="create-container-modal"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t('취소')}
          </Button>
          <Button primary disabled={busy} type="submit" form="create-container-form">
            {busy ? t('접수 중…') : t('실행')}
          </Button>
        </>
      }
    >
      <form id="create-container-form" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        {/* CLI 명령어 가져오기 토글 및 템플릿 바 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-[#536454]">
              {t('빠른 시작 템플릿')}
            </span>
            <button
              type="button"
              onClick={() => setShowCliInput(!showCliInput)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline"
            >
              <Terminal size={13} />
              {showCliInput ? t('CLI 입력 닫기') : t('Docker Run CLI 붙여넣기')}
            </button>
          </div>

          {showCliInput && (
            <div className="flex flex-col gap-2 rounded-[8px] border border-[#d2ddd0] bg-[#f8faf6] p-3">
              <span className="text-[11px] text-[#536454]">
                {t('터미널의 docker run 명령어를 붙여넣으면 양식에 맞추어 자동 파싱합니다.')}
              </span>
              <div className="flex gap-2">
                <input
                  value={cliInput}
                  onChange={(e) => setCliInput(e.target.value)}
                  placeholder="docker run -d --name my-app -p 8080:80 nginx:alpine"
                  className="h-8.5 flex-1 rounded-[6px] border border-[#dce2d9] bg-white px-2.5 font-mono text-[12px] text-ink outline-0"
                />
                <Button primary compact type="button" onClick={applyCliCommand}>
                  {t('명령어 적용')}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {CONTAINER_TEMPLATES.map((tpl) => (
              <button
                key={tpl.name}
                type="button"
                className="rounded-[6px] border border-[#dce2d9] bg-white px-2.75 py-1 text-[12px] font-medium text-ink transition-colors hover:border-[#bdcdbb] hover:bg-[#f2f6ed]"
                onClick={() => applyTemplate(tpl)}
              >
                {tpl.name}
              </button>
            ))}
          </div>
        </div>

        <label className={tw.field}>
          <span>{t('이미지')} *</span>
          <input
            required
            autoComplete="off"
            placeholder="nginx:alpine, redis:alpine 등"
            value={image}
            onChange={(e) => setImage(e.target.value)}
          />
        </label>

        <label className={tw.field}>
          <span>{t('컨테이너 이름')}</span>
          <input
            autoComplete="off"
            placeholder="my-web"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className={tw.field}>
          <span>{t('포트')}</span>
          <input
            autoComplete="off"
            placeholder="8080:80, 8443:443"
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
          />
          <small>{t('호스트 포트:컨테이너 포트. Windows의 127.0.0.1에 공개합니다.')}</small>
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-[#536454]">{t('환경 변수')}</span>
            <button
              type="button"
              onClick={() => setShowEnvPresets(!showEnvPresets)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline"
            >
              <Bookmark size={12} />
              {t('프리셋 허브')}
            </button>
          </div>

          {showEnvPresets && (
            <div className="flex flex-col gap-2 rounded-[8px] border border-[#d2ddd0] bg-[#f8faf6] p-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#536454]">{t('추천 환경 변수 프리셋')}</span>
                <button
                  type="button"
                  onClick={() => setSavingPreset(!savingPreset)}
                  className="text-[11px] font-semibold text-brand hover:underline"
                >
                  {savingPreset ? t('취소') : t('현재 입력값 프리셋으로 저장')}
                </button>
              </div>

              {savingPreset && (
                <div className="flex gap-2 py-1">
                  <input
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder={t('프리셋 이름 (예: My App Dev)')}
                    className="h-8 flex-1 rounded-[6px] border border-[#dce2d9] bg-white px-2 text-[11px]"
                  />
                  <Button compact primary type="button" onClick={handleSaveCustomPreset}>
                    {t('저장')}
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_ENV_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => handleApplyPreset(p.env)}
                    className="rounded-[5px] border border-[#dce2d9] bg-white px-2 py-1 font-mono text-[11px] text-[#425d48] hover:border-[#bdcdbb] hover:bg-[#edf5e8]"
                  >
                    + {p.name}
                  </button>
                ))}
                {customPresets.map((p) => (
                  <div
                    key={p.name}
                    className="inline-flex items-center gap-1 rounded-[5px] border border-[#bfe2ca] bg-[#eefaf2] px-2 py-1 font-mono text-[11px] text-[#1e6b37]"
                  >
                    <button type="button" onClick={() => handleApplyPreset(p.env)}>
                      + {p.name}
                    </button>
                    <button
                      type="button"
                      className="text-[#8c978e] hover:text-danger"
                      onClick={() => handleDeleteCustomPreset(p.name)}
                      title={t('프리셋 삭제')}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <label className={cn(tw.field, 'my-0')}>
            <textarea
              rows={3}
              placeholder={'APP_ENV=development\nLOG_LEVEL=info'}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
            <small>{t('줄마다 KEY=VALUE 형식으로 입력합니다.')}</small>
          </label>
        </div>

        <label className={tw.field}>
          <span>{t('볼륨과 마운트')}</span>
          <textarea
            rows={3}
            placeholder={'my-vol:/data\nD:\\data:/app/data'}
            value={mounts}
            onChange={(e) => setMounts(e.target.value)}
          />
          <small>
            {t(
              '줄마다 source:target 형식(예: my-vol:/data, D:\\data:/app) 또는 JSON 배열을 입력합니다.',
            )}
          </small>
        </label>

        <label className={tw.field}>
          <span>{t('실행 인수')}</span>
          <input
            autoComplete="off"
            placeholder='sh -c "..." 또는 ["sleep", "infinity"]'
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <small>{t('일반 명령 문자열 또는 JSON 배열을 입력할 수 있습니다.')}</small>
        </label>

        {/* 실시간 Docker CLI 명령어 프리뷰 */}
        <div className="rounded-[8px] border border-[#dce4d6] bg-[#fbfcf9] p-3 text-[12px]">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold text-[#536454]">
              <Terminal size={14} className="text-brand" />
              {t('Docker CLI 명령어')}
            </span>
            <CopyButton text={generatedCliCommand} label={t('명령어 복사')} />
          </div>
          <pre className="max-h-[80px] overflow-auto font-mono text-[11px] leading-relaxed text-[#2c3d31] whitespace-pre-wrap select-all">
            {generatedCliCommand}
          </pre>
        </div>

        {error && (
          <p role="alert" className="text-[12px] whitespace-pre-wrap text-[#ad413a]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
