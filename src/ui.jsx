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
import { createPortal } from 'react-dom';
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
import { api } from './api.js';
import { cn, tw } from './tw.js';
export const DataGrid = lazy(() =>
  import('./components/DataGrid/DataGrid.jsx').then((m) => ({ default: m.DataGrid })),
);

export const Actions = createContext(null);

export const useActions = () => useContext(Actions);

// 상단바 오른쪽 액션 영역과 제목을 페이지가 채운다. 제목과 액션은 상단바에만 두고 본문에 반복하지 않는다.
export const TopBar = createContext({ slot: null, setTitle: () => {} });

export function PageActions({ children }) {
  const { slot } = useContext(TopBar);
  return slot ? createPortal(children, slot) : null;
}

export function usePageTitle(title) {
  const { setTitle } = useContext(TopBar);
  useEffect(() => {
    setTitle(title || null);
    return () => setTitle(null);
  }, [title, setTitle]);
}

export function PageAction({ primary, className, ...props }) {
  return (
    <IconButton
      className={cn(
        'h-9.5 w-9.5 border border-line bg-white enabled:hover:border-[#bdcdbb] enabled:hover:bg-[#f2f6ed]',
        primary &&
          'border-brand bg-brand text-[#f2ffe4] enabled:hover:border-brand-hover enabled:hover:bg-brand-hover enabled:hover:text-[#f2ffe4]',
        className,
      )}
      {...props}
    />
  );
}

export const useData = (key, url, options = {}) =>
  useQuery({ queryKey: [key], queryFn: () => api(url), ...options });

export const jobNames = {
  installRuntime: '런타임 설치',
  startRuntime: '엔진 시작',
  stopRuntime: '엔진 종료',
  startKubernetes: 'Kubernetes 시작',
  stopKubernetes: 'Kubernetes 종료',
  containerAction: '컨테이너 작업',
  createContainer: '컨테이너 실행',
  pullImage: '이미지 가져오기',
  pushImage: '이미지 보내기',
  buildImage: '이미지 빌드',
  removeImage: '이미지 삭제',
  tagImage: '이미지 태그',
  createVolume: '볼륨 생성',
  removeVolume: '볼륨 삭제',
  createNetwork: '네트워크 생성',
  removeNetwork: '네트워크 삭제',
  compose: 'Compose 작업',
  kubeApply: '리소스 적용',
  kubeDelete: '리소스 삭제',
  snapshot: '스냅샷 생성',
  restoreSnapshot: '스냅샷 복원',
  deleteSnapshot: '스냅샷 삭제',
  installCLI: 'Windows CLI 설치',
  createForward: '포트 전달 시작',
  stopForward: '포트 전달 종료',
  registryLogin: '레지스트리 로그인',
  registryLogout: '레지스트리 로그아웃',
  installExtension: '확장 설치',
  uninstallExtension: '확장 제거',
  exportImage: '이미지 내보내기',
  importImage: '이미지 불러오기',
  scanImage: '이미지 분석',
};

export const stateNames = { queued: '접수', running: '진행 중', succeeded: '완료', failed: '실패' };

export function Button({ icon: Icon, children, primary, compact, className, ...props }) {
  return (
    <button
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-[8px] border border-[#dce2d9] bg-white px-3.75 py-2.75 text-[13px] font-semibold whitespace-nowrap text-ink transition-[background,border-color] duration-[140ms] enabled:hover:border-[#bdcdbb] enabled:hover:bg-[#f2f6ed] max-tablet:min-h-10.5',
        primary && 'border-brand bg-brand text-[#f2ffe4] enabled:hover:bg-brand-hover',
        compact && 'min-h-8.5 px-3 py-2 max-tablet:min-h-8.5',
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={16} aria-hidden="true" />}
      {children}
    </button>
  );
}

// 삭제 버튼: 표 안(danger="row")은 배경과 마우스 효과 없이 빨간 아이콘만, 카드 안(danger)은 마우스를 올리면 연한 빨간 배경을 보인다.
export function IconButton({ icon: Icon, label, danger, className, ...props }) {
  return (
    <button
      className={cn(
        'inline-flex min-h-8.5 min-w-8.5 flex-none items-center justify-center rounded-[6px] bg-transparent p-2 text-[#738177] enabled:hover:bg-[#edf2e7] enabled:hover:text-brand max-tablet:min-h-9.5 max-tablet:min-w-9.5',
        danger && 'text-danger enabled:hover:bg-[#faeeeb] enabled:hover:text-danger',
        danger === 'row' && 'enabled:hover:bg-transparent',
        className,
      )}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

export function Badge({ state, children }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.75 rounded-[5px] bg-[#f0f2ee] px-2 py-1.25 text-[11px] leading-none font-semibold whitespace-nowrap text-[#7a837c] [&>span]:h-1.25 [&>span]:w-1.25 [&>span]:rounded-full [&>span]:bg-current',
        ['running', 'succeeded', 'ready'].includes(state) && 'bg-[#eef5e9] text-[#407543]',
        state === 'failed' && 'bg-[#faeeeb] text-[#b24639]',
      )}
    >
      <span />
      {children ||
        { running: '실행 중', exited: '종료', created: '생성됨', paused: '일시 정지' }[state] ||
        state}
    </span>
  );
}

export function Skeleton() {
  return (
    <div className="flex flex-col gap-4.5 p-7.5" aria-label="불러오는 중">
      {[1, 2, 3, 4].map((i) => (
        <div className={tw.skeleton} key={i} />
      ))}
    </div>
  );
}

const EMPTY =
  'flex flex-col items-center gap-3.5 px-7 py-17 text-center text-[#81917f] [&_h3]:text-[#3d5343] [&_p]:max-w-[640px] [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere';

export function ErrorState({ error, retry }) {
  return (
    <div className={EMPTY}>
      <CircleHelp size={30} />
      <h3>연결을 확인해 주세요</h3>
      <p>{error?.message || error}</p>
      {retry && (
        <Button onClick={retry} icon={RefreshCw}>
          다시 시도
        </Button>
      )}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className={EMPTY}>
      <Box size={32} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export const bytes = (n) =>
  typeof n === 'number'
    ? n >= 1073741824
      ? `${(n / 1073741824).toFixed(2)} GB`
      : `${(n / 1048576).toFixed(1)} MB`
    : n || '—';

export const containerName = (r) => (r.Names?.[0] || r.Id?.slice(0, 12) || '').replace(/^\//, '');

export const imageName = (r) =>
  r.RepoTags?.find((t) => t !== '<none>:<none>') || r.Id?.slice(0, 19);

export function RuntimeEmpty() {
  const { status, job, busy } = useActions();
  if (status?.managed === false)
    return (
      <Empty title="Rancher Desktop 엔진 연결을 확인해 주세요">
        Rancher Desktop에서 Docker 엔진을 시작하면 Naru가 자동으로 연결합니다.
      </Empty>
    );
  return (
    <div className="flex min-h-[calc(100dvh-86px)] flex-col items-center justify-center px-7.5 py-15 text-center max-tablet:min-h-[calc(100dvh-68px)]">
      <div className="mb-7 flex h-23.5 w-23.5 -rotate-5 items-center justify-center rounded-[26px] bg-[#e8eedf]">
        <img className="h-16 w-16 rotate-5" src="/brand/naru-mark.png" alt="" />
      </div>
      <h2 className="mb-7 text-[34px] max-tablet:text-[28px]">
        {status?.installed ? 'Naru 엔진이 꺼져 있습니다' : '독립 런타임이 설치되지 않았습니다'}
      </h2>
      <Button
        primary
        disabled={busy || !status}
        icon={status?.installed ? Play : Download}
        onClick={() => job(status?.installed ? 'startRuntime' : 'installRuntime')}
      >
        {status?.installed ? 'Naru 엔진 시작' : '독립 런타임 설치'}
      </Button>
      <small className="mt-5 text-[11px]">Naru 전용 WSL2 환경을 사용합니다.</small>
    </div>
  );
}

export function useResource(kind) {
  const { status } = useActions();
  return useData(kind, '/' + kind, {
    enabled: !!status?.ready,
    refetchInterval: (status?.pollSeconds || 5) * 1000,
  });
}

// 갱신 때 같은 행을 그대로 이어 쓰도록 안정적인 행 키를 준다. 없으면 AG Grid가 행을 모두 새로 만들어 깜빡이고 스크롤이 초기화된다.
export const rowKey = (r) =>
  String(
    r.Id ??
      r.id ??
      r.metadata?.uid ??
      (r.metadata
        ? `${r.kind || ''}/${r.metadata.namespace || ''}/${r.metadata.name}`
        : (r.Name ?? JSON.stringify(r))),
  );
const getRowId = ({ data }) => rowKey(data);

export function ResourceGrid({ query, columns, filter = '', onRowClicked }) {
  const rows = useMemo(
    () =>
      (query.data || []).filter((r) =>
        JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()),
      ),
    [query.data, filter],
  );
  return (
    // 부모 패널의 남은 높이를 채운다. AG Grid가 높이를 계산할 수 있도록 안쪽은 절대 위치로 둔다.
    <div className="relative min-h-[340px] w-full flex-1">
      <div className="absolute inset-0 flex">
        <Suspense fallback={<Skeleton />}>
          <DataGrid
            rowData={rows}
            columnDefs={columns}
            getRowId={getRowId}
            isLoading={query.isLoading}
            errorMessage={query.error?.message || ''}
            emptyMessage={filter ? '검색 결과가 없습니다.' : '아직 항목이 없습니다.'}
            onRowClicked={onRowClicked}
            rowHeight={62}
          />
        </Suspense>
      </div>
    </div>
  );
}

// wrap은 좁은 화면에서 오른쪽 작업 영역을 다음 줄로 내리고 검색창을 넓힌다.
export function Toolbar({ search, onSearch, children, wrap }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4.5 px-5.5 py-4.25 max-tablet:p-3.5',
        wrap && 'max-tablet:flex-wrap max-tablet:gap-2',
      )}
    >
      <div
        className={cn(
          'flex h-9.5 w-full max-w-[370px] items-center gap-2.5 rounded-[7px] border border-[#e3e8df] bg-[#fcfdfb] px-3 text-[#8c978e]',
          wrap && 'max-tablet:max-w-none',
        )}
      >
        <Search size={17} />
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-0 placeholder:text-[#9aa29b]"
          aria-label="목록 검색"
          placeholder="이름, 이미지, ID 검색"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {search && <IconButton label="검색 지우기" icon={X} onClick={() => onSearch('')} />}
      </div>
      <div className={cn(tw.actions, wrap && 'max-tablet:w-full max-tablet:justify-between')}>
        {children}
      </div>
    </div>
  );
}
