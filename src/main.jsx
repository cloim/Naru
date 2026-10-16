import { Actions, Button, IconButton, Badge, Skeleton, Empty, useData, jobNames } from './ui.jsx';
import { FormDialog, JobDialog } from './dialogs.jsx';
const Extensions = lazy(() => import('./pages/Extensions.jsx'));
const Containers = lazy(() => import('./pages/Containers.jsx'));
const ContainerDetail = lazy(() => import('./pages/ContainerDetail.jsx'));
const Images = lazy(() => import('./pages/Images.jsx'));
const Resources = lazy(() => import('./pages/Resources.jsx'));
const Compose = lazy(() => import('./pages/Compose.jsx'));
const Kubernetes = lazy(() => import('./pages/Kubernetes.jsx'));
const Forwards = lazy(() => import('./pages/Forwards.jsx'));
const Snapshots = lazy(() => import('./pages/Snapshots.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Diagnostics = lazy(() => import('./pages/Diagnostics.jsx'));
const Jobs = lazy(() => import('./pages/Jobs.jsx'));
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Link,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Puzzle,
} from 'lucide-react';

import { Modal } from './components/Modal/Modal.jsx';
import SelectControl from './components/SelectControl/SelectControl.tsx';
import { api, downloadConfig } from './api.js';
import { cn, tw } from './tw.js';
import './tailwind.css';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import './components/DataGrid/data-grid.css';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 3000, retry: false, refetchOnWindowFocus: true } },
});

const navLink = ({ isActive }) =>
  cn(
    'flex items-center gap-3.25 rounded-[9px] px-4 py-3.25 text-[14px] font-medium transition-[background] duration-150 hover:bg-[#ffffff0b] max-desktop:gap-2.5 max-desktop:p-3',
    isActive && 'bg-[#31554a] text-[#f1ffdf] hover:bg-[#31554a]',
  );

function Shell() {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    location = useLocation();
  const status = useData('status', '/status', {
      refetchInterval: (q) => (q.state.data?.pollSeconds || 5) * 1000,
    }),
    jobs = useData('jobs', '/jobs', {
      refetchInterval: (q) =>
        q.state.data?.some((j) => ['queued', 'running'].includes(j.state)) ? 1000 : 10000,
    });
  const [dialog, setDialog] = useState(null),
    [alert, setAlert] = useState(null),
    [jobId, setJobId] = useState(null),
    [drawer, setDrawer] = useState(false),
    [submitting, setSubmitting] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const sidebarRef = useRef(null),
    menuRef = useRef(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const changed = () => {
      setMobile(media.matches);
      if (!media.matches) setDrawer(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!mobile || !drawer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const links = () => [...sidebarRef.current.querySelectorAll('a[href],button:not([disabled])')];
    links()[0]?.focus();
    const keydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDrawer(false);
      }
      if (e.key === 'Tab') {
        const items = links(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      menuRef.current?.focus();
    };
  }, [mobile, drawer]);
  const active = jobs.data?.find((j) => ['queued', 'running'].includes(j.state));
  const completedRef = useRef('');
  useEffect(() => {
    const finished =
      jobs.data
        ?.filter((j) => ['failed', 'succeeded'].includes(j.state))
        .map((j) => j.id)
        .join(',') || '';
    if (completedRef.current && completedRef.current !== finished)
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'jobs' });
    completedRef.current = finished;
  }, [jobs.data, queryClient]);
  useEffect(() => setDrawer(false), [location.pathname]);
  // 화면 함수는 갱신 주기와 무관하게 같은 참조를 유지해야 그리드 컬럼 정의가 매번 다시 만들어지지 않는다.
  const notify = useCallback(
    (e) =>
      setAlert({
        title: e instanceof Error ? '작업을 확인해 주세요' : '알림',
        text: e.message || e,
      }),
    [],
  );
  const job = useCallback(
    async (type, payload = {}) => {
      setSubmitting(true);
      try {
        const result = await api('/jobs', { method: 'POST', body: { type, payload } });
        setDialog(null);
        setJobId(result.id);
        queryClient.invalidateQueries();
        return result;
      } catch (e) {
        notify(e);
      } finally {
        setSubmitting(false);
      }
    },
    [queryClient, notify],
  );
  const form = useCallback(
    (title, fields, onSubmit, description) => setDialog({ title, fields, onSubmit, description }),
    [],
  );
  const view = useCallback(
    (title, value) =>
      setDialog({
        title,
        fields: [
          {
            key: 'value',
            label: '내용',
            value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
            type: 'textarea',
            rows: 20,
          },
        ],
        readOnly: true,
        onSubmit: () => setDialog(null),
      }),
    [],
  );
  const confirm = useCallback(
    (title, text, onSubmit, word) =>
      setDialog({
        title,
        description: text,
        fields: word
          ? [
              {
                key: 'confirmation',
                label: `계속하려면 ${word} 입력`,
                required: true,
                pattern: word,
              },
            ]
          : [],
        onSubmit,
      }),
    [],
  );
  const busy = !!active || submitting;
  const context = useMemo(
    () => ({ status: status.data, job, form, confirm, view, notify, busy }),
    [status.data, job, form, confirm, view, notify, busy],
  );
  const nav = [
    ['/', '컨테이너', Container],
    ['/images', '이미지', Layers],
    ['/compose', 'Compose', FileCode],
    ['/kubernetes', 'Kubernetes', ShipWheel],
    ['/ports', '포트 전달', ArrowUpRight],
    ['/volumes', '볼륨', HardDrive],
    ['/networks', '네트워크', Network],
    ['/snapshots', '스냅샷', Camera],
    ['/extensions', '확장', Puzzle],
  ];
  const title = location.pathname.startsWith('/containers/')
    ? '컨테이너 상세'
    : [...nav, ['/settings', '설정'], ['/diagnostics', '진단'], ['/jobs', '작업 기록']].find(
        ([p]) => p === location.pathname,
      )?.[1] || 'Naru';
  return (
    <Actions.Provider value={context}>
      <div className="flex h-dvh overflow-hidden">
        {drawer && (
          <button
            className="fixed inset-0 z-99 hidden bg-[#102c2466] max-tablet:block"
            aria-label="메뉴 닫기"
            onClick={() => setDrawer(false)}
          />
        )}
        <aside
          id="main-navigation"
          ref={sidebarRef}
          inert={mobile && !drawer}
          className={cn(
            'flex w-56 flex-none flex-col bg-brand px-4.5 pt-8.5 pb-5 text-[#c7d6ce] wide:w-60 max-desktop:w-47.5 max-desktop:px-3 max-desktop:py-7 max-tablet:fixed max-tablet:inset-y-0 max-tablet:left-0 max-tablet:z-100 max-tablet:w-57.5 max-tablet:-translate-x-full max-tablet:transition-transform max-tablet:duration-200 max-tablet:ease-[ease]',
            drawer && 'max-tablet:translate-x-0',
          )}
        >
          <Link
            to="/"
            className="mx-3.5 mb-11 flex items-center gap-2.25 font-display text-[32px] font-semibold tracking-[-1.6px] text-[#f6ffe9] hover:bg-[#ffffff0b] max-desktop:ml-3"
          >
            <img className="h-9.5 w-9.5" src="/naru.svg" alt="" />
            <span>
              Naru<span className="text-[#d2edac]">.</span>
            </span>
          </Link>
          <nav aria-label="주요 메뉴" className="flex flex-col gap-1.25">
            {nav.map(([to, label, Icon]) => (
              <NavLink end={to === '/'} key={to} to={to} className={navLink}>
                <Icon size={19} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-0.5 border-t border-[#ffffff16] pt-4.5">
            <NavLink to="/jobs" className={navLink}>
              <Activity size={18} />
              작업 기록{' '}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#cbeaa7]" />}
            </NavLink>
            <NavLink to="/diagnostics" className={navLink}>
              <Activity size={18} />
              진단
            </NavLink>
            <NavLink to="/settings" className={navLink}>
              <Settings2 size={18} />
              설정
            </NavLink>
          </div>
        </aside>
        <div id="workspace" className="flex min-w-0 flex-1 flex-col" inert={mobile && drawer}>
          <header className="flex h-21 min-h-21 items-center justify-between gap-4.5 border-b border-line bg-[#fbfcf8] px-9.5 wide:px-13 max-desktop:px-6 max-tablet:h-17 max-tablet:min-h-17 max-tablet:px-4">
            <div className="flex items-center gap-2.5">
              <button
                ref={menuRef}
                aria-expanded={drawer}
                aria-controls="main-navigation"
                className="hidden min-h-8.5 min-w-8.5 flex-none items-center justify-center rounded-[6px] bg-transparent p-2 text-[#738177] hover:bg-[#edf2e7] hover:text-brand max-tablet:inline-flex max-tablet:min-h-9.5 max-tablet:min-w-9.5"
                onClick={() => setDrawer(!drawer)}
                aria-label="메뉴 열기"
              >
                <Menu size={22} />
              </button>
              {location.pathname.startsWith('/containers/') ? (
                <div className="flex items-center gap-3 text-[18px] [&_a]:text-muted">
                  <Link to="/">컨테이너</Link>
                  <ChevronRight size={18} />
                  <span>상세</span>
                </div>
              ) : (
                <h1>{title}</h1>
              )}
            </div>
            <div className="flex items-center gap-3.25 max-tablet:gap-1.75">
              {status.isLoading ? (
                <span className={cn(tw.skeleton, 'block h-6.25 w-40')} />
              ) : status.error ? (
                <button className="text-accent underline" onClick={() => notify(status.error)}>
                  상태 확인
                </button>
              ) : (
                <>
                  <span className="font-display text-[12px] text-muted max-tablet:hidden">
                    {status.data?.managed === false
                      ? 'External Engine | Docker'
                      : status.data?.engine === 'moby'
                        ? 'Docker'
                        : 'containerd'}
                  </span>
                  <Badge state={status.data?.ready ? 'ready' : 'stopped'}>
                    {status.data?.ready ? '준비됨' : status.data?.running ? '준비 중' : '종료됨'}
                  </Badge>
                  {status.data?.managed === false ? null : !status.data?.installed ? (
                    <Button
                      primary
                      compact
                      className="max-tablet:p-1.5 max-tablet:text-[11px]"
                      disabled={context.busy}
                      onClick={() => job('installRuntime')}
                      icon={Download}
                    >
                      런타임 설치
                    </Button>
                  ) : (
                    <IconButton
                      className="border border-line bg-[#e9ede5]"
                      icon={status.data?.running ? Square : Play}
                      label={status.data?.running ? '엔진 종료' : '엔진 시작'}
                      disabled={context.busy}
                      onClick={() =>
                        status.data?.running
                          ? confirm(
                              '엔진 종료',
                              'Naru의 컨테이너와 Kubernetes를 정상 종료합니다.',
                              () => job('stopRuntime'),
                            )
                          : job('startRuntime')
                      }
                    />
                  )}
                </>
              )}
            </div>
          </header>
          {active && (
            <button
              className="flex items-center gap-2.5 border-b border-[#dde8d3] bg-[#edf5e2] px-9.5 py-2.5 text-left text-[12px] text-[#496d3e] max-tablet:px-4"
              onClick={() => setJobId(active.id)}
            >
              <LoaderCircle size={15} className="animate-spin [animation-duration:1.2s]" />
              {jobNames[active.type] || active.type}
              <span className="ml-auto flex items-center gap-2">
                진행 보기 <ChevronRight size={14} />
              </span>
            </button>
          )}
          <main className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
            <Suspense fallback={<Skeleton />}>
              {status.data?.managed === false &&
              ['/kubernetes', '/ports', '/snapshots', '/extensions'].some((route) =>
                location.pathname.startsWith(route),
              ) ? (
                <Empty title="External Engine에서 관리하는 기능입니다">
                  Naru는 같은 Docker 엔진의 컨테이너, 이미지, 볼륨, 네트워크와 Compose를 관리합니다.
                  실행 환경과 Kubernetes는 External Engine에서 관리해 주세요.
                </Empty>
              ) : (
                <Routes>
                  <Route path="/" element={<Containers />} />
                  <Route path="/containers/:id" element={<ContainerDetail />} />
                  <Route path="/images" element={<Images />} />
                  <Route path="/volumes" element={<Resources kind="volumes" />} />
                  <Route path="/networks" element={<Resources kind="networks" />} />
                  <Route path="/compose" element={<Compose />} />
                  <Route path="/kubernetes" element={<Kubernetes />} />
                  <Route path="/ports" element={<Forwards />} />
                  <Route path="/extensions" element={<Extensions />} />
                  <Route path="/extensions/:id" element={<Extensions />} />
                  <Route path="/snapshots" element={<Snapshots />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/diagnostics" element={<Diagnostics />} />
                  <Route path="/jobs" element={<Jobs openJob={setJobId} />} />
                  <Route
                    path="*"
                    element={
                      <Empty
                        title="페이지를 찾을 수 없습니다"
                        action={<Link to="/">컨테이너로 이동</Link>}
                      />
                    }
                  />
                </Routes>
              )}
            </Suspense>
          </main>
        </div>
      </div>
      {dialog && <FormDialog value={dialog} close={() => setDialog(null)} busy={submitting} />}
      <Modal
        isOpen={!!alert}
        title={alert?.title || '알림'}
        onClose={() => setAlert(null)}
        size="sm"
        footer={
          <Button primary onClick={() => setAlert(null)}>
            확인
          </Button>
        }
      >
        <p className={tw.preserve}>{alert?.text}</p>
      </Modal>
      {jobId && (
        <JobDialog
          id={jobId}
          close={() => {
            setJobId(null);
            queryClient.invalidateQueries();
          }}
        />
      )}
    </Actions.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </QueryClientProvider>,
);
