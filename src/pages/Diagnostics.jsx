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
  Skeleton,
  ErrorState,
  bytes,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Diagnostics() {
  useLocale();
  const data = useData('diagnostics', '/diagnostics'),
    { status } = useActions();
  return (
    <section className={tw.page}>
      {data.isLoading ? (
        <Skeleton />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : (
        <>
          <div
            className={cn(
              tw.panel,
              'flex flex-wrap gap-8.75 px-7.5 py-6.25 max-tablet:p-5.5 [&_span]:text-[12px] [&_span]:text-muted [&_strong]:text-[14px] [&_strong]:font-medium [&_strong]:wrap-anywhere [&>div]:flex [&>div]:min-w-[180px] [&>div]:flex-1 [&>div]:flex-col [&>div]:gap-3',
            )}
          >
            <div>
              <span>{t('WSL 배포판')}</span>
              <strong>{data.data.distributions.join(', ')}</strong>
            </div>
            <div>
              <span>{t('제어 서버 메모리')}</span>
              <strong>{bytes(data.data.memory.rss)}</strong>
            </div>
            <div>
              <span>Node</span>
              <strong>{data.data.node}</strong>
            </div>
            <div>
              <span>{t('데이터 경로')}</span>
              <strong>{status?.dataPath}</strong>
            </div>
          </div>
          {Object.entries(data.data.logs).map(([key, value]) => (
            <section className={tw.panel} key={key}>
              <h3 className="px-6 py-5">
                {key === 'engine'
                  ? t('엔진')
                  : key === 'kubernetes'
                    ? 'Kubernetes'
                    : t('빌드 엔진')}{' '}
                {t('로그')}{' '}
              </h3>
              <pre className={cn(tw.terminal, 'max-h-[400px] min-h-[100px] rounded-none')}>
                {value || t('아직 로그가 없습니다.')}
              </pre>
            </section>
          ))}
        </>
      )}
    </section>
  );
}
export default Diagnostics;
