import { t, useLocale } from './i18n.js';
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
  Ellipsis,
} from 'lucide-react';
import { api } from './api.js';
import { cn, tw } from './tw.js';
import { Tooltip } from './components/Tooltip.jsx';
export { Tooltip };
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
  compactDisk: '디스크 압축',
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
  compose: '프로젝트 저장',
  project: '프로젝트 작업',
  deleteProject: '프로젝트 삭제',
  kubeApply: '리소스 적용',
  kubeDelete: '리소스 삭제',
  snapshot: '스냅샷 생성',
  restoreSnapshot: '스냅샷 복원',
  deleteSnapshot: '스냅샷 삭제',
  installCLI: 'Windows CLI 설치',
  createForward: '포트 전달 시작',
  stopForward: '포트 전달 종료',
  removeForward: '포트 전달 기록 삭제',
  registryLogin: '레지스트리 로그인',
  registryLogout: '레지스트리 로그아웃',
  installExtension: '확장 설치',
  uninstallExtension: '확장 제거',
  exportImage: '이미지 내보내기',
  importImage: '이미지 불러오기',
  scanImage: '이미지 분석',
  pruneResources: '미사용 리소스 정리',
  pruneImages: '미사용 이미지 정리',
  pruneVolumes: '미사용 볼륨 정리',
  pruneNetworks: '미사용 네트워크 정리',
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
  const button = (
    <button
      className={cn(
        'inline-flex min-h-8.5 min-w-8.5 flex-none items-center justify-center rounded-[6px] bg-transparent p-2 text-[#738177] enabled:hover:bg-[#edf2e7] enabled:hover:text-brand max-tablet:min-h-9.5 max-tablet:min-w-9.5',
        danger && 'text-danger enabled:hover:bg-[#faeeeb] enabled:hover:text-danger',
        danger === 'row' && 'enabled:hover:bg-transparent',
        className,
      )}
      aria-label={label}
      {...props}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
  return label ? <Tooltip content={label}>{button}</Tooltip> : button;
}

// 행에서 자주 쓰지 않는 작업을 모은다. 메뉴는 포털로 띄워 표 셀에 잘리지 않게 하고, 아래 공간이 부족하면 위로 연다.
export function RowMenu({ label, items }) {
  useLocale();
  const [anchor, setAnchor] = useState(null);
  const buttonRef = useRef(null),
    menuRef = useRef(null),
    restoreFocus = useRef(false);
  const [place, setPlace] = useState(null);
  const shown = items.filter(Boolean);
  const close = useCallback((focus) => {
    restoreFocus.current = !!focus;
    setAnchor(null);
    setPlace(null);
  }, []);
  // 툴팁 감싸기가 다시 생기면서 버튼이 새로 그려지므로, 닫힌 뒤의 버튼에 포커스를 돌려준다.
  useEffect(() => {
    if (anchor || !restoreFocus.current) return;
    restoreFocus.current = false;
    buttonRef.current?.focus();
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const menu = menuRef.current;
    const height = menu.offsetHeight,
      width = menu.offsetWidth;
    const below = anchor.bottom + 4 + height <= window.innerHeight - 8;
    setPlace({
      top: below ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - height),
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
    });
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (e) => {
      if (!menu.contains(e.target) && !buttonRef.current?.contains(e.target)) close();
    };
    const dismiss = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [anchor, close]);
  const keydown = (e) => {
    const options = [...menuRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = options.indexOf(document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    }
  };
  return (
    <>
      <IconButton
        ref={buttonRef}
        icon={Ellipsis}
        // 메뉴가 열려 있는 동안에는 툴팁이 메뉴를 가리지 않게 접근 가능한 이름만 남긴다.
        label={anchor ? undefined : label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        data-no-row-click="true"
        onClick={(e) => {
          e.stopPropagation();
          window.__naru_no_row_click = Date.now();
          if (anchor) close();
          else setAnchor(buttonRef.current.getBoundingClientRect());
        }}
      />
      {anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            data-ui-audit-overlay
            data-no-row-click="true"
            onKeyDown={keydown}
            className="fixed z-[1000] min-w-[184px] rounded-[10px] border border-line bg-paper p-1.5 shadow-[0_12px_32px_rgba(20,45,38,0.16)]"
            style={
              place || { top: anchor.bottom + 4, left: anchor.right - 184, visibility: 'hidden' }
            }
          >
            {shown.map(({ icon: Icon, label: text, onClick, danger, disabled }) => (
              <button
                key={text}
                type="button"
                role="menuitem"
                disabled={disabled}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2.75 text-left text-[13px] whitespace-nowrap text-ink enabled:hover:bg-[#f0f5ea] focus-visible:bg-[#f0f5ea] focus-visible:outline-none',
                  danger && 'text-danger enabled:hover:bg-[#faeeeb] focus-visible:bg-[#faeeeb]',
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  window.__naru_no_row_click = Date.now();
                  close(true);
                  onClick();
                }}
              >
                <Icon size={15} aria-hidden="true" className={danger ? '' : 'text-[#6b7b72]'} />
                {text}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function CopyButton({ text, label, className }) {
  useLocale();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (e) => {
      e.stopPropagation();
      e.nativeEvent?.stopImmediatePropagation?.();
      window.__naru_no_row_click = Date.now();
      if (!text) return;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(String(text));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [text],
  );
  const title = label || (copied ? t('복사 완료') : t('클립보드에 복사'));
  return (
    <Tooltip content={title}>
      <button
        type="button"
        data-no-row-click="true"
        className={cn(
          'inline-flex h-6 w-6 flex-none items-center justify-center rounded-[4px] text-[#8c978e] transition-colors hover:bg-[#edf2e7] hover:text-brand',
          copied && 'text-[#407543]',
          className,
        )}
        aria-label={title}
        onClick={copy}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

const BADGE_TONE = {
  ok: ['bg-[#e4f2df] text-accent', 'bg-[#3f9b6b]'],
  wait: ['bg-[#fbf2dc] text-[#86641f]', ''],
  bad: ['bg-[#faeeeb] text-[#b24639]', 'bg-danger'],
  off: ['bg-[#eef0ec] text-[#69736c]', 'bg-[#a9b2ac]'],
};
const badgeTone = (state) =>
  ['running', 'succeeded', 'ready'].includes(state)
    ? 'ok'
    : ['queued', 'starting', 'restarting', 'creating'].includes(state)
      ? 'wait'
      : ['failed', 'dead'].includes(state)
        ? 'bad'
        : 'off';

// 상태는 색 점과 문구를 함께 보여 준다. 진행 중인 상태는 점 대신 회전 표시를 쓴다.
// 수치만 보여 주는 배지는 marker={false}로 점과 회전 표시를 뺀다.
export function Badge({ state, tone = badgeTone(state), marker = true, children }) {
  useLocale();
  const [color, dot] = BADGE_TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.75 rounded-full py-1.25 pr-2.5 pl-2.25 text-[11.5px] leading-none font-semibold whitespace-nowrap',
        !marker && 'px-2.25 tabular-nums',
        color,
      )}
    >
      {!marker ? null : tone === 'wait' ? (
        <LoaderCircle size={11} className="flex-none animate-spin" aria-hidden="true" />
      ) : (
        <span className={cn('h-1.75 w-1.75 flex-none rounded-full', dot)} aria-hidden="true" />
      )}
      {children ||
        { running: t('실행 중'), exited: t('종료'), created: t('생성됨'), paused: t('일시 정지') }[
          state
        ] ||
        state}
    </span>
  );
}

// 목록 위 요약 수치. items는 [이름, 값, 단위] 목록이고, 카드 수에 맞춰 넓은 화면은 한 줄, 좁은 화면은 두 줄로 놓는다.
export function StatCards({ items }) {
  return (
    <div
      className={cn(
        'grid flex-none gap-4 max-desktop:grid-cols-2 max-tablet:gap-3',
        items.length >= 4 ? 'grid-cols-4' : items.length === 3 ? 'grid-cols-3' : 'grid-cols-2',
      )}
      data-ui-audit-card-group
    >
      {items.map(([label, value, unit]) => (
        <div
          key={label}
          className={cn(tw.panel, 'px-5 py-4 max-tablet:px-4 max-tablet:py-3')}
          data-ui-audit-card
        >
          <div className="text-[12px] text-muted">{label}</div>
          <div className="mt-1.5 flex items-baseline gap-1.5 font-display text-[27px] leading-none font-semibold text-ink tabular-nums max-tablet:text-[22px]">
            {value}
            {unit && <small className="text-[14px] font-medium text-muted">{unit}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Skeleton() {
  useLocale();
  return (
    <div
      className="skeleton-enter flex w-full min-w-0 flex-col gap-4.5 p-7.5"
      role="status"
      aria-label={t('불러오는 중')}
    >
      {[1, 2, 3, 4].map((i) => (
        <div className={tw.skeleton} key={i} aria-hidden="true" />
      ))}
    </div>
  );
}

const EMPTY =
  'flex flex-col items-center gap-3.5 px-7 py-17 text-center text-[#81917f] [&_h3]:text-[#3d5343] [&_p]:max-w-[640px] [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere';

export function ErrorState({ error, retry }) {
  useLocale();
  return (
    <div className={EMPTY}>
      <CircleHelp size={30} />
      <h3>{t('연결을 확인해 주세요')}</h3>
      <p>{error?.message || error}</p>
      {retry && (
        <Button onClick={retry} icon={RefreshCw}>
          {' '}
          {t('다시 시도')}{' '}
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
  useLocale();
  const { status, job, busy } = useActions();
  if (status?.managed === false)
    return (
      <div className={tw.page}>
        <h2>{t('원격 엔진 연결을 확인해 주세요')}</h2>
        <p className={tw.preserve}>{status.error}</p>
        <Link to="/engines">{t('연결 관리')}</Link>
      </div>
    );
  return (
    <div className="flex min-h-[calc(100dvh-86px)] flex-col items-center justify-center px-7.5 py-15 text-center max-tablet:min-h-[calc(100dvh-68px)]">
      <div className="mb-7 flex h-23.5 w-23.5 -rotate-5 items-center justify-center rounded-[26px] bg-brand">
        <img className="h-16 w-16 rotate-5" src="/brand/naru-mark.png?v=20261017c" alt="" />
      </div>
      <h2 className="mb-7 text-[34px] max-tablet:text-[28px]">
        {status?.installed
          ? t('Naru 엔진이 꺼져 있습니다')
          : t('독립 런타임이 설치되지 않았습니다')}
      </h2>
      <Button
        primary
        disabled={busy || !status}
        icon={status?.installed ? Play : Download}
        onClick={() => job(status?.installed ? 'startRuntime' : 'installRuntime')}
      >
        {status?.installed ? t('Naru 엔진 시작') : t('독립 런타임 설치')}
      </Button>
      <small className="mt-5 text-[11px]">{t('Naru 전용 WSL2 환경을 사용합니다.')}</small>
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

export function ResourceGrid({ query, columns, filter = '', onRowClicked, ...gridProps }) {
  useLocale();
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
            emptyMessage={filter ? t('검색 결과가 없습니다.') : t('아직 항목이 없습니다.')}
            onRowClicked={onRowClicked}
            rowHeight={62}
            {...gridProps}
          />
        </Suspense>
      </div>
    </div>
  );
}

// wrap은 좁은 화면에서 오른쪽 작업 영역을 다음 줄로 내리고 검색창을 넓힌다.
export function Toolbar({ search, onSearch, children, wrap }) {
  useLocale();
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
          aria-label={t('목록 검색')}
          placeholder={t('이름, 이미지, ID 검색')}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {search && <IconButton label={t('검색 지우기')} icon={X} onClick={() => onSearch('')} />}
      </div>
      {/* 빈 동작 영역을 그리면 줄바꿈 간격만큼 아래 여백이 위보다 커진다. */}
      {React.Children.toArray(children).length > 0 && (
        <div className={cn(tw.actions, wrap && 'max-tablet:w-full max-tablet:justify-between')}>
          {children}
        </div>
      )}
    </div>
  );
}
