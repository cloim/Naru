import { t, useLocale } from '../i18n.js';
import React, { useEffect, useState } from 'react';
import { Modal } from './Modal/Modal.jsx';
import SelectControl from './SelectControl/SelectControl.tsx';
import { Button } from '../ui.jsx';
import { tw } from '../tw.js';
import { parseCommandInput, parseMountsInput, parsePortsInput } from './CreateContainerModal.jsx';

function initialForm(inspect) {
  const config = inspect?.Config || {};
  const host = inspect?.HostConfig || {};
  const ports = [
    ...new Set(
      Object.entries(inspect?.NetworkSettings?.Ports || {}).flatMap(([target, bindings]) =>
        (bindings || []).map((binding) => {
          const [containerPort, protocol = 'tcp'] = target.split('/');
          const hostIp = ['::', '0.0.0.0'].includes(binding.HostIp)
            ? '0.0.0.0'
            : ['::1', '127.0.0.1', ''].includes(binding.HostIp)
              ? '127.0.0.1'
              : binding.HostIp;
          return `${hostIp}:${binding.HostPort}:${containerPort}${protocol === 'tcp' ? '' : `/${protocol}`}`;
        }),
      ),
    ),
  ].join(', ');
  const mounts = (inspect?.Mounts || [])
    .map((mount) => {
      const source = mount.Type === 'volume' ? mount.Name : mount.Source;
      return `${source}:${mount.Destination}${mount.RW ? '' : ':ro'}`;
    })
    .join('\n');
  const nanoCpus =
    host.NanoCpus ||
    (host.CpuQuota > 0 ? (host.CpuQuota / (host.CpuPeriod || 100000)) * 1_000_000_000 : 0);
  return {
    image: config.Image || '',
    name: inspect?.Name?.replace(/^\//, '') || '',
    ports,
    env: (config.Env || []).join('\n'),
    mounts,
    command: config.Cmd?.length ? JSON.stringify(config.Cmd) : '',
    restart: host.RestartPolicy?.Name || 'no',
    cpus: nanoCpus > 0 ? String(nanoCpus / 1_000_000_000) : '',
    memoryMiB: host.Memory > 0 ? String(Math.round(host.Memory / 1048576)) : '',
  };
}

export function EditContainerModal({ inspect, isOpen, busy, onClose, onSubmit }) {
  useLocale();
  const [form, setForm] = useState(() => initialForm(inspect));
  const [error, setError] = useState('');
  const composeProject = inspect?.Config?.Labels?.['com.docker.compose.project'];

  useEffect(() => {
    if (isOpen) {
      setForm(initialForm(inspect));
      setError('');
    }
  }, [inspect, isOpen]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const cpus = form.cpus.trim() ? Number(form.cpus) : 0;
      const memoryMiB = form.memoryMiB.trim() ? Number(form.memoryMiB) : 0;
      if (!form.image.trim()) throw new Error(t('이미지 이름을 입력해 주세요.'));
      if (!Number.isFinite(cpus) || cpus < 0 || cpus > 256) {
        throw new Error(t('CPU 제한은 0에서 256 사이 숫자로 입력해 주세요.'));
      }
      if (!Number.isFinite(memoryMiB) || memoryMiB < 0 || memoryMiB > 1_073_741_824) {
        throw new Error(t('메모리 제한을 MiB 단위의 올바른 숫자로 입력해 주세요.'));
      }
      const result = await onSubmit({
        image: form.image.trim(),
        name: form.name.trim() || undefined,
        ports: parsePortsInput(form.ports),
        env: form.env
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        mounts: parseMountsInput(form.mounts),
        command: parseCommandInput(form.command),
        restart: form.restart,
        nanoCpus: Math.round(cpus * 1_000_000_000),
        memory: Math.round(memoryMiB * 1048576),
      });
      if (result) onClose();
    } catch (reason) {
      setError(reason.message || String(reason));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? undefined : onClose}
      closeOnEscape={!busy}
      closeOnOverlayClick={!busy}
      title={t('컨테이너 설정 변경')}
      size="lg"
      resizable
      storageKey="edit-container-modal"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t('취소')}
          </Button>
          <Button primary disabled={busy} type="submit" form="edit-container-form">
            {busy ? t('접수 중…') : t('변경 적용')}
          </Button>
        </>
      }
    >
      <form id="edit-container-form" onSubmit={submit} className="flex flex-col gap-3.5">
        <div className="rounded-[8px] border border-[#d7e2d2] bg-[#f5f9f2] px-3.5 py-3 text-[12px] leading-5 text-[#425546]">
          {composeProject
            ? t('Compose 프로젝트 {0}의 서비스 정의를 저장하고 이 서비스만 재생성합니다', [
                composeProject,
              ])
            : t(
                '기존 컨테이너를 임시 보관한 뒤 새 설정으로 재생성하며, 실패하면 기존 컨테이너를 복구합니다',
              )}
        </div>

        <div className="grid grid-cols-2 gap-3.5 max-tablet:grid-cols-1">
          <label className={tw.field}>
            <span>{t('이미지')} *</span>
            <input required autoComplete="off" value={form.image} onChange={set('image')} />
          </label>
          <label className={tw.field}>
            <span>{t('컨테이너 이름')}</span>
            <input autoComplete="off" value={form.name} onChange={set('name')} />
          </label>
        </div>

        <label className={tw.field}>
          <span>{t('포트')}</span>
          <input
            autoComplete="off"
            placeholder="8080:80, 8443:443"
            value={form.ports}
            onChange={set('ports')}
          />
          <small>
            {t('호스트IP:호스트포트:컨테이너포트 형식이며, IP를 생략하면 127.0.0.1을 사용합니다')}
          </small>
        </label>

        <label className={tw.field}>
          <span>{t('환경 변수')}</span>
          <textarea rows={4} value={form.env} onChange={set('env')} />
          <small>{t('줄마다 KEY=VALUE 형식으로 입력합니다.')}</small>
        </label>

        <label className={tw.field}>
          <span>{t('볼륨과 마운트')}</span>
          <textarea rows={3} value={form.mounts} onChange={set('mounts')} />
          <small>{t('줄마다 source:target 또는 source:target:ro 형식으로 입력합니다')}</small>
        </label>

        <label className={tw.field}>
          <span>{t('실행 인수')}</span>
          <input autoComplete="off" value={form.command} onChange={set('command')} />
          <small>{t('JSON 배열 또는 공백으로 구분한 인수를 입력합니다')}</small>
        </label>

        <div className="grid grid-cols-3 gap-3.5 max-tablet:grid-cols-1" data-ui-audit-row>
          <label className={tw.field}>
            <span>{t('재시작 정책')}</span>
            <SelectControl value={form.restart} onChange={set('restart')}>
              <option value="no">{t('사용 안 함')}</option>
              <option value="unless-stopped">unless-stopped</option>
              <option value="always">always</option>
              <option value="on-failure">on-failure</option>
            </SelectControl>
          </label>
          <label className={tw.field}>
            <span>{t('CPU 제한')}</span>
            <input
              type="number"
              min="0"
              max="256"
              step="0.1"
              placeholder={t('무제한')}
              value={form.cpus}
              onChange={set('cpus')}
            />
            <small>{t('CPU 코어 수')}</small>
          </label>
          <label className={tw.field}>
            <span>{t('메모리 제한')}</span>
            <input
              type="number"
              min="0"
              step="1"
              placeholder={t('무제한')}
              value={form.memoryMiB}
              onChange={set('memoryMiB')}
            />
            <small>MiB</small>
          </label>
        </div>

        {error && (
          <p role="alert" className="m-0 text-[12px] whitespace-pre-wrap text-[#ad413a]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
