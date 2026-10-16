import { t, useLocale } from './i18n.js';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Layers,
  HardDrive,
  Network,
  Settings2,
  Activity,
  Camera,
  Play,
  Square,
  RotateCw,
  Trash2,
  Download,
  Plus,
  Search,
  ChevronRight,
  Terminal,
  FileCode,
  Menu,
  X,
  Copy,
  ArrowUpRight,
  Pause,
  RefreshCw,
  CircleHelp,
  Check,
  LoaderCircle,
  Container,
  ShipWheel,
  Tag,
} from 'lucide-react';
import { Button, Badge, Skeleton, ErrorState, useData, jobNames, stateNames } from './ui.jsx';
import { cn, tw } from './tw.js';
import { Modal } from './components/Modal/Modal.jsx';
export function FormDialog({ value, close, busy }) {
  useLocale();
  const [values, setValues] = useState(
      Object.fromEntries(value.fields.map((f) => [f.key, f.value || ''])),
    ),
    [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await value.onSubmit(values);
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <Modal
      isOpen
      onClose={close}
      closeOnEscape={!busy}
      closeOnOverlayClick={!busy}
      title={value.title}
      size={value.fields.some((f) => f.type === 'textarea') ? 'lg' : 'md'}
      storageKey="form-dialog"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {' '}
            {t('취소')}{' '}
          </Button>
          <Button primary disabled={busy} type="submit" form="action-form">
            {value.readOnly ? t('닫기') : busy ? t('접수 중…') : t('실행')}
          </Button>
        </>
      }
    >
      <form id="action-form" onSubmit={submit}>
        {value.description && <p className="mb-4.5 text-[13px] text-muted">{value.description}</p>}
        {value.fields.map((f) => (
          <label className={tw.field} key={f.key}>
            <span>{f.label}</span>
            {f.type === 'textarea' ? (
              <textarea
                readOnly={value.readOnly}
                rows={f.rows || 6}
                required={f.required}
                value={values[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            ) : (
              <input
                autoComplete="off"
                type={f.type || 'text'}
                required={f.required}
                pattern={f.pattern}
                value={values[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}{' '}
            {f.hint && <small>{f.hint}</small>}
          </label>
        ))}
        {error && (
          <p role="alert" className="text-[12px] whitespace-pre-wrap text-[#ad413a]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function JobDialog({ id, close }) {
  useLocale();
  const data = useData('job:' + id, '/jobs/' + id, {
    refetchInterval: (q) =>
      ['queued', 'running'].includes(q.state.data?.job?.state || 'queued') ? 1000 : false,
  });
  const bottom = useRef();
  // 최신 Chrome의 scrollIntoView는 Promise를 돌려주므로 effect 정리 함수로 넘기지 않는다.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [data.data?.log]);
  return (
    <Modal
      isOpen
      onClose={close}
      title={t(jobNames[data.data?.job.type]) || t('작업 진행')}
      size="lg"
      storageKey="job-log"
      resizable
      footer={
        <>
          <span className="mr-auto" aria-live="polite">
            {data.data && (
              <Badge state={data.data.job.state}>{t(stateNames[data.data.job.state])}</Badge>
            )}
          </span>
          <Button onClick={close}>{t('닫기')}</Button>
        </>
      }
    >
      {data.error ? (
        <ErrorState error={data.error} />
      ) : (
        <pre className={cn(tw.terminal, 'h-[410px] max-h-none min-h-[220px] max-tablet:h-[50vh]')}>
          {data.data?.log || t('작업을 접수했습니다. 준비 중…')}
          <span ref={bottom} />
        </pre>
      )}
    </Modal>
  );
}
