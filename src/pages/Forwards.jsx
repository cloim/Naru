import { t, useLocale } from '../i18n.js';
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
import {
  useActions,
  useData,
  Button,
  IconButton,
  CopyButton,
  Badge,
  ResourceGrid,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Forwards() {
  const locale = useLocale();
  const data = useData('forwards', '/forwards', { refetchInterval: 5000 }),
    { job, form, confirm, busy, status } = useActions();
  const columns = useMemo(
    () => [
      { field: 'resource', headerName: t('리소스'), minWidth: 230, flex: 1.2 },
      {
        field: 'namespace',
        headerName: t('네임스페이스'),
        minWidth: 160,
        flex: 0.7,
        filterable: true,
      },
      {
        headerName: t('로컬 주소'),
        minWidth: 220,
        flex: 1,
        valueGetter: ({ data: r }) => `127.0.0.1:${r.localPort} → ${r.remotePort}`,
        cellRenderer: ({ data: r }) => {
          const url = `http://127.0.0.1:${r.localPort}`;
          return (
            <div
              className="flex items-center gap-1.5 py-1 text-[12px]"
              onClick={(e) => e.stopPropagation()}
            >
              {r.state === 'running' ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[#2c6e49] underline decoration-[#2c6e49]/30 hover:decoration-[#2c6e49]"
                  title={t('{0} 브라우저에서 열기', [url])}
                >
                  <span>{`127.0.0.1:${r.localPort} → ${r.remotePort}`}</span>
                  <ArrowUpRight size={13} className="flex-none opacity-70" />
                </a>
              ) : (
                <span className="font-mono text-[#8c978e]">{`127.0.0.1:${r.localPort} → ${r.remotePort}`}</span>
              )}
              <CopyButton text={url} label={t('{0} 주소 복사', [url])} />
            </div>
          );
        },
      },
      {
        field: 'state',
        headerName: t('상태'),
        width: 130,
        cellRenderer: ({ value }) => <Badge state={value} />,
      },
      {
        headerName: '',
        width: 90,
        sortable: false,
        cellRenderer: ({ data: r }) =>
          r.state === 'running' ? (
            <IconButton
              icon={Square}
              label={t('전달 종료')}
              disabled={busy}
              onClick={() => job('stopForward', { id: r.id })}
            />
          ) : (
            <IconButton
              icon={Trash2}
              danger="row"
              label={t('{0} 포트 전달 기록 삭제', [r.resource])}
              disabled={busy}
              onClick={() =>
                confirm(
                  t('포트 전달 기록 삭제'),
                  t('{0}/{1} (127.0.0.1:{2}) 기록을 삭제합니다.', [
                    r.namespace,
                    r.resource,
                    r.localPort,
                  ]),
                  () => job('removeForward', { id: r.id }),
                )
              }
            />
          ),
      },
    ],
    [locale, busy, job, confirm],
  );
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label={t('포트 연결')}
          primary
          icon={Plus}
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              t('포트 전달'),
              [
                {
                  key: 'resource',
                  label: t('대상 리소스'),
                  required: true,
                  placeholder: 'svc/my-web',
                  hint: t('svc/이름, pod/이름, deployment/이름'),
                },
                { key: 'namespace', label: t('네임스페이스'), value: 'default' },
                {
                  key: 'localPort',
                  label: t('Windows 로컬 포트'),
                  type: 'number',
                  required: true,
                  value: '8080',
                },
                {
                  key: 'remotePort',
                  label: t('대상 포트'),
                  type: 'number',
                  required: true,
                  value: '80',
                },
              ],
              (v) =>
                job('createForward', {
                  ...v,
                  localPort: Number(v.localPort),
                  remotePort: Number(v.remotePort),
                }),
            )
          }
        />
      </PageActions>
      <div className={tw.gridPanel}>
        <ResourceGrid query={data} columns={columns} />
      </div>
    </section>
  );
}
export default Forwards;
