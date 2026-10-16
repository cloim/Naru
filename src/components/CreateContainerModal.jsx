import { t, useLocale } from '../i18n.js';
import React, { useState, useEffect } from 'react';
import { Modal } from './Modal/Modal.jsx';
import { Button } from '../ui.jsx';
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
      if (!match) throw new Error(t('볼륨 마운트 형식(source:target)이 올바르지 않습니다: {0}', [line]));
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

export function CreateContainerModal({ isOpen, onClose, onSubmit, busy, initialValues }) {
  useLocale();
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [ports, setPorts] = useState('');
  const [env, setEnv] = useState('');
  const [mounts, setMounts] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');

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
        <div>
          <span className="mb-1.5 block text-[12px] font-semibold text-[#536454]">
            {t('빠른 시작 템플릿')}
          </span>
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

        <label className={tw.field}>
          <span>{t('환경 변수')}</span>
          <textarea
            rows={3}
            placeholder={'APP_ENV=development\nLOG_LEVEL=info'}
            value={env}
            onChange={(e) => setEnv(e.target.value)}
          />
          <small>{t('줄마다 KEY=VALUE 형식으로 입력합니다.')}</small>
        </label>

        <label className={tw.field}>
          <span>{t('볼륨과 마운트')}</span>
          <textarea
            rows={3}
            placeholder={'my-vol:/data\nD:\\data:/app/data'}
            value={mounts}
            onChange={(e) => setMounts(e.target.value)}
          />
          <small>
            {t('줄마다 source:target 형식(예: my-vol:/data, D:\\data:/app) 또는 JSON 배열을 입력합니다.')}
          </small>
        </label>

        <label className={tw.field}>
          <span>{t('실행 인수')}</span>
          <input
            autoComplete="off"
            placeholder="sh -c &quot;...&quot; 또는 [&quot;sleep&quot;, &quot;infinity&quot;]"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <small>{t('일반 명령 문자열 또는 JSON 배열을 입력할 수 있습니다.')}</small>
        </label>

        {error && (
          <p role="alert" className="text-[12px] whitespace-pre-wrap text-[#ad413a]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
