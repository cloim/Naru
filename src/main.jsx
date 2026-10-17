import { t, useLocale } from './i18n.js';
import { Actions, TopBar, Button, PageAction, Skeleton, Empty, useData, jobNames } from './ui.jsx';
import { FormDialog, JobDialog } from './dialogs.jsx';
const Extensions = lazy(() => import('./pages/Extensions.jsx'));
const Containers = lazy(() => import('./pages/Containers.jsx'));
const ContainerDetail = lazy(() => import('./pages/ContainerDetail.jsx'));
const Images = lazy(() => import('./pages/Images.jsx'));
const Resources = lazy(() => import('./pages/Resources.jsx'));
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
  Navigate,
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
  History,
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
  TriangleAlert,
} from 'lucide-react';

import { Modal } from './components/Modal/Modal.jsx';
import { CommandPalette } from './components/CommandPalette/CommandPalette.jsx';
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
    'flex items-center gap-3.25 rounded-[9px] px-4 py-3.25 text-[14px] font-medium transition-[background] duration-150 hover:bg-[#ffffff0b] max-desktop:gap-2.5 max-desktop:p-3 max-tablet:py-2.5',
    isActive && 'bg-[#31554a] text-[#f1ffdf] hover:bg-[#31554a]',
  );

function Shell() {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    location = useLocation();
  // 서버 재시작이나 wsl.exe 지연으로 한 번 실패한 조회는 다시 시도해 상단바 경고가 깜빡이지 않게 한다.
  const status = useData('status', '/status', {
      refetchInterval: (q) => (q.state.data?.pollSeconds || 5) * 1000,
      retry: 2,
      retryDelay: 1500,
    }),
    jobs = useData('jobs', '/jobs', {
      refetchInterval: (q) =>
        q.state.data?.some((j) => ['queued', 'running'].includes(j.state)) ? 1000 : 10000,
    });
  const [actionSlot, setActionSlot] = useState(null),
    [pageTitle, setPageTitle] = useState(null);
  const topBar = useMemo(() => ({ slot: actionSlot, setTitle: setPageTitle }), [actionSlot]);
  const [dialog, setDialog] = useState(null),
    [alert, setAlert] = useState(null),
    [jobId, setJobId] = useState(null),
    [drawer, setDrawer] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [paletteOpen, setPaletteOpen] = useState(false);

  const containers = useData('containers', '/containers', {
    enabled: !!status.data?.ready,
    refetchInterval: (status.data?.pollSeconds || 5) * 1000,
  });
  const runningCount = useMemo(
    () => (containers.data || []).filter((c) => c.State === 'running').length,
    [containers.data],
  );

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
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
        title: e instanceof Error ? t('작업을 확인해 주세요') : t('알림'),
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
            label: t('내용'),
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
                label: t('계속하려면 {0} 입력', [word]),
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
    ['/', t('컨테이너'), Container],
    ['/images', t('이미지'), Layers],
    ['/kubernetes', 'Kubernetes', ShipWheel],
    ['/ports', t('포트 전달'), ArrowUpRight],
    ['/volumes', t('볼륨'), HardDrive],
    ['/networks', t('네트워크'), Network],
    ['/snapshots', t('스냅샷'), Camera],
    ['/extensions', t('확장'), Puzzle],
  ];
  const title = location.pathname.startsWith('/containers/')
    ? t('컨테이너 상세')
    : [
        ...nav,
        ['/settings', t('설정')],
        ['/diagnostics', t('진단')],
        ['/jobs', t('작업 기록')],
      ].find(([p]) => p === location.pathname)?.[1] || 'Naru';
  return (
    <Actions.Provider value={context}>
      <TopBar.Provider value={topBar}>
        <div className="flex h-dvh overflow-hidden">
          {drawer && (
            <button
              className="fixed inset-0 z-99 hidden bg-[#102c2466] max-tablet:block"
              aria-label={t('메뉴 닫기')}
              onClick={() => setDrawer(false)}
            />
          )}
          <aside
            id="main-navigation"
            ref={sidebarRef}
            inert={mobile && !drawer}
            className={cn(
              'flex w-56 flex-none flex-col overflow-y-auto overscroll-contain bg-brand px-4.5 pt-8.5 pb-5 text-[#c7d6ce] wide:w-60 max-desktop:w-47.5 max-desktop:px-3 max-desktop:py-7 max-tablet:fixed max-tablet:inset-y-0 max-tablet:left-0 max-tablet:z-100 max-tablet:w-57.5 max-tablet:pt-6 max-tablet:pb-4 max-tablet:-translate-x-full max-tablet:transition-transform max-tablet:duration-200 max-tablet:ease-[ease]',
              drawer && 'max-tablet:translate-x-0',
            )}
          >
            <Link
              to="/"
              className="mx-auto mb-11 flex w-fit max-w-full flex-none items-center rounded-[10px] hover:bg-[#ffffff0b] max-tablet:mb-6"
            >
              <img className="h-auto w-[100px] max-w-full" src="/brand/naru-wordmark.png?v=20261017c" alt="Naru" />
            </Link>
            <nav aria-label={t('주요 메뉴')} className="flex flex-col gap-1.25">
              {nav.map(([to, label, Icon]) => (
                <NavLink end={to === '/'} key={to} to={to} className={navLink}>
                  <Icon size={19} aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-0.5 border-t border-[#ffffff16] pt-4.5">
              <NavLink to="/jobs" className={navLink}>
                <History size={18} /> {t('작업 기록')}{' '}
              </NavLink>
              <NavLink to="/diagnostics" className={navLink}>
                <Activity size={18} /> {t('진단')}{' '}
              </NavLink>
              <NavLink to="/settings" className={navLink}>
                <Settings2 size={18} /> {t('설정')}{' '}
              </NavLink>
            </div>
          </aside>
          <div id="workspace" className="flex min-w-0 flex-1 flex-col" inert={mobile && drawer}>
            <header className="flex h-21 min-h-21 items-center justify-between gap-4.5 border-b border-line bg-[#fbfcf8] px-4 max-tablet:h-17 max-tablet:min-h-17">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  ref={menuRef}
                  aria-expanded={drawer}
                  aria-controls="main-navigation"
                  className="hidden min-h-8.5 min-w-8.5 flex-none items-center justify-center rounded-[6px] bg-transparent p-2 text-[#738177] hover:bg-[#edf2e7] hover:text-brand max-tablet:inline-flex max-tablet:min-h-9.5 max-tablet:min-w-9.5"
                  onClick={() => setDrawer(!drawer)}
                  aria-label={t('메뉴 열기')}
                >
                  <Menu size={22} />
                </button>
                {location.pathname.startsWith('/containers/') ? (
                  <div className="flex min-w-0 items-center gap-3 text-[18px] [&_a]:text-muted">
                    <Link to="/" className="flex-none whitespace-nowrap">
                      {' '}
                      {t('컨테이너')}{' '}
                    </Link>
                    <ChevronRight size={18} className="flex-none" />
                    <span className="min-w-0 truncate">{pageTitle || t('상세')}</span>
                  </div>
                ) : (
                  <h1 className="min-w-0 truncate">{pageTitle || title}</h1>
                )}
                {status.data?.ready && (
                  <Link
                    to="/"
                    className="ml-2 inline-flex flex-none items-center gap-1.5 rounded-[6px] bg-[#edf5e7] px-2.5 py-1 text-[11px] font-semibold text-[#3b6d47] transition-colors hover:bg-[#e2edd9]"
                    title={t('실행 중인 컨테이너 목록으로 이동')}
                  >
                    <span className="h-1.75 w-1.75 rounded-full bg-[#407543]" />
                    {t('실행 중 {0}', [runningCount])}
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2 max-tablet:gap-1.5">
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  className="inline-flex items-center gap-2 rounded-[7px] border border-[#e3e8df] bg-white px-2.5 py-1 text-[12px] text-[#7a857c] transition-colors hover:border-[#bdcdbb] hover:text-ink max-tablet:hidden"
                  title={t('빠른 이동 (Ctrl+K)')}
                >
                  <Search size={14} />
                  <span>{t('빠른 이동')}</span>
                  <kbd className="rounded bg-[#f0f2ee] px-1 py-0.5 text-[10px] font-mono text-[#7a837c]">
                    Ctrl+K
                  </kbd>
                </button>
                <div ref={setActionSlot} className="flex items-center gap-2 max-tablet:gap-1.5" />
                {status.error ? (
                  <PageAction
                    icon={TriangleAlert}
                    label={t('엔진 상태 조회 실패 원인 보기')}
                    className="text-danger"
                    onClick={() => notify(status.error)}
                  />
                ) : null}
              </div>
            </header>
            {active && (
              <button
                className="flex items-center gap-2.5 border-b border-[#dde8d3] bg-[#edf5e2] px-9.5 py-2.5 text-left text-[12px] text-[#496d3e] max-tablet:px-4"
                onClick={() => setJobId(active.id)}
              >
                <LoaderCircle size={15} className="animate-spin [animation-duration:1.2s]" />
                {t(jobNames[active.type]) || active.type}
                <span className="ml-auto flex items-center gap-2">
                  {' '}
                  {t('진행 보기')} <ChevronRight size={14} />
                </span>
              </button>
            )}
            <main className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
              <Suspense fallback={<Skeleton />}>
                {status.data?.managed === false &&
                ['/kubernetes', '/ports', '/snapshots', '/extensions'].some((route) =>
                  location.pathname.startsWith(route),
                ) ? (
                  <Empty title={t('Rancher Desktop에서 관리하는 기능입니다')}>
                    {' '}
                    {t(
                      'Naru는 같은 Docker 엔진의 컨테이너, 이미지, 볼륨, 네트워크와 Compose를 관리합니다. 실행 환경과 Kubernetes는 Rancher Desktop에서 관리해 주세요.',
                    )}{' '}
                  </Empty>
                ) : (
                  <Routes>
                    <Route path="/" element={<Containers />} />
                    <Route path="/containers/:id" element={<ContainerDetail />} />
                    <Route path="/images" element={<Images />} />
                    <Route path="/volumes" element={<Resources kind="volumes" />} />
                    <Route path="/networks" element={<Resources kind="networks" />} />
                    <Route path="/compose" element={<Navigate to="/" replace />} />
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
                          title={t('페이지를 찾을 수 없습니다')}
                          action={<Link to="/">{t('컨테이너로 이동')}</Link>}
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
          title={alert?.title || t('알림')}
          onClose={() => setAlert(null)}
          size="sm"
          footer={
            <Button primary onClick={() => setAlert(null)}>
              {' '}
              {t('확인')}{' '}
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
        <CommandPalette
          isOpen={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onPrune={() => {
            confirm(
              t('미사용 리소스 정리'),
              t(
                '중지된 컨테이너, 태그 없는 이미지와 미사용 네트워크를 일괄 삭제하여 가상 디스크 용량을 확보합니다. 볼륨 데이터는 유지됩니다.',
              ),
              () => job('pruneResources', { all: true, volumes: false }),
            );
          }}
        />
      </TopBar.Provider>
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
