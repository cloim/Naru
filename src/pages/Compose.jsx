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
import { useActions, useData, Button, Skeleton, ErrorState } from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
const composeExample =
  'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n';

function Compose() {
  const data = useData('compose', '/compose'),
    { job, confirm, busy, status } = useActions();
  const [name, setName] = useState('my-app'),
    [yaml, setYaml] = useState(composeExample);
  return (
    <section className={tw.page}>
      <div className={tw.pageIntro}>
        <div>
          <h2>함께 움직이는 서비스</h2>
          <p>Compose 파일 하나로 개발 환경을 실행하세요.</p>
        </div>
        <Button
          icon={Plus}
          onClick={() => {
            setName('my-app');
            setYaml(composeExample);
          }}
        >
          새 프로젝트
        </Button>
      </div>
      <div className="flex min-h-[580px] flex-1 gap-5.5 max-tablet:min-h-0 max-tablet:flex-col">
        <div
          className={cn(
            tw.panel,
            'w-60 flex-none px-4 py-5.5 max-desktop:w-47.5 max-tablet:max-h-60 max-tablet:w-auto',
          )}
        >
          <h3 className="px-1.75 pb-5 text-[13px]">프로젝트</h3>
          {data.isLoading ? (
            <Skeleton />
          ) : data.error ? (
            <ErrorState error={data.error} />
          ) : data.data?.length ? (
            data.data.map((p) => (
              <button
                key={p.name}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[7px] bg-transparent px-2.5 py-3.25 text-left text-[#74806f] [&>svg:last-child]:ml-auto',
                  p.name === name && 'bg-[#edf3e7] text-[#355b3c]',
                )}
                onClick={() => {
                  setName(p.name);
                  setYaml(p.yaml);
                }}
              >
                <FileCode size={17} />
                {p.name}
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <p className="p-2 text-[12px] text-muted">첫 프로젝트를 실행해 보세요.</p>
          )}
        </div>
        <div
          className={cn(
            tw.panel,
            'flex flex-1 flex-col px-6.5 py-5 max-tablet:min-h-[500px] max-tablet:px-4',
          )}
        >
          <label className={cn(tw.field, 'mt-1.25 mb-3.75')}>
            <span>프로젝트 이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label
            className={cn(
              tw.field,
              'mt-1.25 mb-3.75 flex-1 [&_textarea]:min-h-[300px] [&_textarea]:flex-1 [&_textarea]:bg-[#f9fbf6] [&_textarea]:text-[13px] [&_textarea]:leading-[1.65]',
            )}
          >
            <span>compose.yaml</span>
            <textarea spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} />
          </label>
          <div className="my-3 flex flex-wrap justify-end gap-2.25">
            <Button
              icon={Square}
              disabled={busy || !status?.ready}
              onClick={() => job('compose', { name, yaml, action: 'stop' })}
            >
              중지
            </Button>
            <Button
              icon={Trash2}
              disabled={busy || !status?.ready}
              onClick={() =>
                confirm(
                  'Compose 환경 해제',
                  '컨테이너와 네트워크를 제거합니다. 이름 있는 볼륨은 보존됩니다.',
                  () => job('compose', { name, yaml, action: 'down' }),
                )
              }
            >
              환경 해제
            </Button>
            <Button
              icon={Terminal}
              disabled={busy || !status?.ready}
              onClick={() => job('compose', { name, yaml, action: 'logs' })}
            >
              로그
            </Button>
            <Button
              primary
              icon={Play}
              disabled={busy || !status?.ready}
              onClick={() => job('compose', { name, yaml, action: 'up' })}
            >
              프로젝트 실행
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
export default Compose;
