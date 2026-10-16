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
import { useActions, useData, Button, Skeleton, ErrorState, bytes } from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Diagnostics() {
  const data = useData('diagnostics', '/diagnostics'),
    { notify } = useActions();
  return (
    <section className={tw.page}>
      <div className={tw.pageIntro}>
        <div>
          <h2>환경 상태와 로그</h2>
          <p>실제 실행 환경을 확인하고 문제의 원인을 살펴보세요.</p>
        </div>
        <Button icon={RefreshCw} onClick={() => data.refetch()}>
          다시 확인
        </Button>
      </div>
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
              <span>WSL 배포판</span>
              <strong>{data.data.distributions.join(', ')}</strong>
            </div>
            <div>
              <span>제어 서버 메모리</span>
              <strong>{bytes(data.data.memory.rss)}</strong>
            </div>
            <div>
              <span>Node</span>
              <strong>{data.data.node}</strong>
            </div>
          </div>
          <div className={cn(tw.panel, tw.group)}>
            <h3>Docker CLI 사용</h3>
            <code className="mb-3.75 block rounded-[6px] bg-[#f3f6ed] p-3.75 text-[12px] wrap-anywhere">
              docker ps
            </code>
            <Button
              icon={Copy}
              onClick={() =>
                navigator.clipboard
                  .writeText('docker ps')
                  .then(() => notify('명령을 복사했습니다.'))
                  .catch(notify)
              }
            >
              복사
            </Button>
          </div>
          {Object.entries(data.data.logs).map(([key, value]) => (
            <section className={tw.panel} key={key}>
              <h3 className="px-6 py-5">
                {key === 'engine' ? '엔진' : key === 'kubernetes' ? 'Kubernetes' : '빌드 엔진'} 로그
              </h3>
              <pre className={cn(tw.terminal, 'max-h-[400px] min-h-[100px] rounded-none')}>
                {value || '아직 로그가 없습니다.'}
              </pre>
            </section>
          ))}
        </>
      )}
    </section>
  );
}
export default Diagnostics;
