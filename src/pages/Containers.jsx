import { engineStorageKey, isRemoteEngine } from '../api.js';
import { t, useLocale } from '../i18n.js';
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Boxes,
  ChevronRight,
  Play,
  Square,
  Trash2,
  Plus,
  FolderPlus,
  Terminal,
  RefreshCw,
  RotateCw,
  Settings2,
  Download,
  Hammer,
  Save,
  ArrowUpRight,
  Globe,
  Search,
  X,
  BrushCleaning,
  Copy,
} from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  IconButton,
  CopyButton,
  Badge,
  Skeleton,
  ErrorState,
  containerName,
  RuntimeEmpty,
  useResource,
  ResourceGrid,
  Toolbar,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api } from '../api.js';
import { publicPortMappings } from '../container-ports.js';
import { Modal } from '../components/Modal/Modal.jsx';
import { CreateContainerModal } from '../components/CreateContainerModal.jsx';

export const isSystemContainer = (r) =>
  Boolean(
    r.Labels?.['io.kubernetes.pod.name'] ||
    r.Labels?.['io.kubernetes.container.name'] ||
    (r.Names || []).some((name) => /^\/?k8s_/.test(name)),
  );
const PROJECT_LABEL = 'com.docker.compose.project';
const NO_PROJECT = '';
// Compose 프로젝트명에 사용할 수 없는 구분자로 표시용 그룹의 키를 분리한다.
const COOLIFY_UTIL = 'group:coolify-util';
const COLLAPSED_KEY = 'naru.collapsedProjects';
const composeExample =
  'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n';

function readCollapsedState() {
  try {
    const raw = localStorage.getItem(engineStorageKey(COLLAPSED_KEY));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const obj = {};
      for (const k of parsed) obj[k] = true;
      return obj;
    }
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// 프로젝트 머리 행은 그리드 셀 렌더러 안에서 그려지므로 화면 동작을 context로 전달한다.
const ProjectContext = createContext(null);

function ProjectRow({ data: g }) {
  useLocale();
  const { job, confirm, busy, toggle, collapsed, openLogs, openManage } = useContext(ProjectContext);
  const open = !collapsed.has(g.__group);
  const named = g.__group !== NO_PROJECT;
  const run = (action) => job('project', { name: g.__group, action });
  return (
    <div
      className="flex h-full cursor-pointer items-center gap-3 bg-[#f6f8f2] pr-3 pl-3.5 max-tablet:gap-2 max-tablet:pl-2.5"
      onClick={() => toggle(g.__group)}
    >
      <ChevronRight
        size={16}
        className={cn('flex-none text-[#7a857c] transition-transform', open && 'rotate-90')}
        aria-hidden
      />
      <Boxes size={19} className="flex-none text-[#4f7750]" aria-hidden />
      <div className="flex min-w-0 flex-col leading-[1.5] max-tablet:flex-1">
        <strong className="truncate text-[13px] text-ink">
          {g.virtual ? 'coolify-util' : named ? g.__group : t('프로젝트 없음')}
        </strong>
        <small className="truncate font-mono text-[10px] text-[#9aa297]">
          {g.virtual
            ? t('Coolify 보조 서비스')
            : named
              ? g.info?.workingDir || t('작업 폴더 정보 없음')
              : t('Compose로 만들지 않은 컨테이너')}
        </small>
      </div>
      <Badge state={g.running > 0 ? 'running' : 'exited'}>{`${g.running}/${g.total}`}</Badge>
      {named && !g.virtual && (
        <div className={cn(tw.rowActions, 'ml-auto')} onClick={(e) => e.stopPropagation()}>
          {g.total === 0 && (
            <IconButton
              icon={Play}
              label={t('{0} 프로젝트 up', [g.__group])}
              disabled={busy || !g.info?.filesFound}
              onClick={() => run('up')}
            />
          )}
          {g.total > 0 && g.running < g.total && (
            <IconButton
              icon={Play}
              label={t('{0} 프로젝트 시작', [g.__group])}
              disabled={busy}
              onClick={() => run('start')}
            />
          )}
          {g.running > 0 && (
            <IconButton
              icon={Square}
              label={t('{0} 프로젝트 정지', [g.__group])}
              disabled={busy}
              onClick={() => run('stop')}
            />
          )}
          {g.total > 0 && (
            <IconButton
              className="max-tablet:hidden"
              icon={RotateCw}
              label={t('{0} 프로젝트 재시작', [g.__group])}
              disabled={busy}
              onClick={() => run('restart')}
            />
          )}
          {g.total > 0 && (
            <IconButton
              className="max-tablet:hidden"
              icon={Terminal}
              label={t('{0} 프로젝트 로그 보기', [g.__group])}
              onClick={() => openLogs(g.__group)}
            />
          )}
          <IconButton
            icon={Settings2}
            label={t('{0} 프로젝트 관리', [g.__group])}
            onClick={() => openManage(g)}
          />
          <IconButton
            icon={Trash2}
            label={t('{0} 프로젝트 삭제', [g.__group])}
            danger="row"
            disabled={busy}
            onClick={() =>
              confirm(
                t('프로젝트 삭제'),
                t('{0} 프로젝트를 삭제합니다. 소속된 컨테이너도 모두 함께 삭제됩니다.', [g.__group]),
                () => job('deleteProject', { name: g.__group }),
              )
            }
          />
        </div>
      )}
    </div>
  );
}

function ProjectLogs({ name, onClose }) {
  useLocale();
  const [logSearch, setLogSearch] = useState('');
  const logs = useData('project-logs:' + name, `/projects/${name}/logs`, {
    enabled: !!name,
    refetchInterval: name ? 5000 : false,
  });
  const rawLog = logs.data?.text || '';
  const filteredLog = useMemo(() => {
    if (!logSearch.trim()) return rawLog;
    const q = logSearch.toLowerCase();
    return rawLog
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [rawLog, logSearch]);

  return (
    <Modal
      isOpen={!!name}
      title={t('{0} 프로젝트 로그', [name || ''])}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <CopyButton
            text={filteredLog || rawLog}
            label={t('로그 복사')}
            className="mr-auto h-9 w-9 border border-[#dce2d9] bg-white"
          />
          <Button icon={RefreshCw} disabled={logs.isFetching} onClick={() => logs.refetch()}>
            {t('새로고침')}
          </Button>
          <Button onClick={onClose}>{t('닫기')}</Button>
        </>
      }
    >
      <div className="mb-2.5 flex h-8.5 w-full items-center gap-2 rounded-[6px] border border-[#e3e8df] bg-[#fcfdfb] px-2.5 text-[#8c978e]">
        <Search size={15} />
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-0 placeholder:text-[#9aa29b]"
          aria-label={t('로그 검색')}
          placeholder={t('로그 검색')}
          value={logSearch}
          onChange={(e) => setLogSearch(e.target.value)}
        />
        {logSearch && (
          <button
            type="button"
            aria-label={t('검색어 지우기')}
            className="text-[#8c978e] hover:text-ink"
            onClick={() => setLogSearch('')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {logs.isLoading ? (
        <Skeleton />
      ) : logs.error ? (
        <ErrorState error={logs.error} retry={() => logs.refetch()} />
      ) : (
        <pre
          className={cn(tw.terminal, 'max-h-[500px] overflow-auto')}
          aria-label={t('프로젝트 로그')}
        >
          {filteredLog ||
            (logSearch ? t('일치하는 로그가 없습니다.') : t('아직 출력된 로그가 없습니다.'))}
        </pre>
      )}
    </Modal>
  );
}

function ProjectManage({ group, onClose, onLogs, containers = [] }) {
  useLocale();
  const { job, confirm, notify, busy } = useActions(),
    qc = useQueryClient(),
    navigate = useNavigate();
  const name = group?.__group;
  const detail = useData('project-files:' + name, `/projects/${name}/files`, { enabled: !!name });
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('topology');
  const managed = detail.data?.managed;
  const yaml = draft ?? detail.data?.files?.[0]?.text ?? '';
  const close = () => {
    setDraft(null);
    onClose();
  };
  const run = (action) => job('project', { name, action }).then(close);
  const ready = !!detail.data?.filesFound;
  const members = useMemo(
    () => (containers || []).filter((c) => c.Labels?.[PROJECT_LABEL] === name),
    [containers, name],
  );
  return (
    <Modal
      isOpen={!!name}
      title={t('{0} 프로젝트 관리', [name || ''])}
      onClose={close}
      size="xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2.25">
          {group?.total > 0 && (
            // 좁은 화면의 머리 행에는 재시작과 로그 버튼을 두지 않으므로 여기서 제공한다.
            <div className="flex gap-2.25 tablet:hidden">
              <Button icon={RotateCw} disabled={busy} onClick={() => run('restart')}>
                {' '}
                {t('재시작')}{' '}
              </Button>
              <Button
                icon={Terminal}
                onClick={() => {
                  close();
                  onLogs(name);
                }}
              >
                {' '}
                {t('로그')}{' '}
              </Button>
            </div>
          )}
          <Button
            icon={Trash2}
            disabled={busy}
            className="border-danger/30 text-danger hover:border-danger hover:bg-[#faeeeb]"
            onClick={() => {
              close();
              confirm(
                t('프로젝트 삭제'),
                t('{0} 프로젝트를 삭제합니다. 소속된 컨테이너도 모두 함께 삭제됩니다.', [name]),
                () => job('deleteProject', { name }),
              );
            }}
          >
            {' '}
            {t('프로젝트 삭제')}{' '}
          </Button>
          <div className="ml-auto flex flex-wrap justify-end gap-2.25">
            <Button
              icon={Trash2}
              disabled={busy || !ready || !group?.total}
              onClick={() => {
                close();
                confirm(
                  t('{0} 프로젝트 down', [name]),
                  t('컨테이너와 네트워크를 제거합니다. 이름 있는 볼륨은 보존됩니다.'),
                  () => job('project', { name, action: 'down' }),
                );
              }}
            >
              down
            </Button>
            <Button icon={Download} disabled={busy || !ready} onClick={() => run('pull')}>
              pull
            </Button>
            <Button icon={Hammer} disabled={busy || !ready} onClick={() => run('build')}>
              build
            </Button>
            {managed && (
              <Button
                icon={Save}
                disabled={busy || draft === null}
                onClick={() => job('compose', { name, yaml, action: 'save' }).then(close)}
              >
                {' '}
                {t('저장')}{' '}
              </Button>
            )}
            <Button
              primary
              icon={Play}
              disabled={busy || !ready}
              onClick={() =>
                managed && draft !== null
                  ? job('compose', { name, yaml, action: 'up' }).then(close)
                  : run('up')
              }
            >
              {managed && draft !== null ? t('저장 후 up') : 'up'}
            </Button>
          </div>
        </div>
      }
    >
      {detail.error ? (
        <ErrorState error={detail.error} retry={() => detail.refetch()} />
      ) : !detail.data ? (
        <Skeleton />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex border-b border-[#e3e8df]">
            <button
              type="button"
              onClick={() => setTab('topology')}
              className={cn(
                'flex items-center gap-2 border-b-2 px-4 py-2.5 text-[13px] font-semibold transition-colors',
                tab === 'topology'
                  ? 'border-brand text-brand'
                  : 'border-transparent text-[#7a857c] hover:text-ink',
              )}
            >
              <Boxes size={15} />
              {t('아키텍처 맵')}
              <span className="rounded-[4px] bg-[#f0f2ed] px-1.5 py-0.5 text-[11px] text-[#808a82]">
                {members.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTab('compose')}
              className={cn(
                'flex items-center gap-2 border-b-2 px-4 py-2.5 text-[13px] font-semibold transition-colors',
                tab === 'compose'
                  ? 'border-brand text-brand'
                  : 'border-transparent text-[#7a857c] hover:text-ink',
              )}
            >
              <Settings2 size={15} />
              {t('설정 파일')}
            </button>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[12px] [&_dd]:font-mono [&_dd]:break-all [&_dt]:font-semibold [&_dt]:text-[#536454]">
            <dt>{t('작업 폴더')}</dt>
            <dd>{detail.data.workingDir}</dd>
            <dt>{t('compose 파일')}</dt>
            <dd>{detail.data.configFiles.join(', ') || t('없음')}</dd>
          </dl>

          {tab === 'topology' ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-[12px] font-semibold text-[#536454]">
                <span>{t('소속 서비스 및 연결 리소스')}</span>
                <span className="text-[11px] font-normal text-muted">
                  {t('실행 중 {0}개 / 총 {1}개', [
                    members.filter((c) => c.State === 'running').length,
                    members.length,
                  ])}
                </span>
              </div>
              {members.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-[#dce4d6] p-6 text-center text-[12px] text-muted">
                  {t(
                    '프로젝트에 생성된 컨테이너가 없습니다. 아래 up 버튼으로 서비스를 기동할 수 있습니다.',
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {members.map((c) => {
                    const cName = containerName(c);
                    const cleanName = cName.replace(/^\//, '');
                    const subDomain = cleanName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    const serviceName = c.Labels?.['com.docker.compose.service'] || cleanName;
                    const networks = Object.keys(c.NetworkSettings?.Networks || {});
                    const ports = publicPortMappings(c.Ports);
                    return (
                      <div
                        key={c.Id}
                        className="flex flex-col justify-between rounded-[8px] border border-[#dce4d6] bg-[#fbfcf9] p-3.5 transition-colors hover:border-[#b8cbb8]"
                      >
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <Box size={16} className="flex-none text-[#64816f]" />
                              <strong className="truncate text-[13px] text-ink">
                                {serviceName}
                              </strong>
                              {serviceName !== cleanName && (
                                <span className="truncate text-[11px] text-muted">
                                  ({cleanName})
                                </span>
                              )}
                            </div>
                            <Badge state={c.State} />
                          </div>

                          <div
                            className="font-mono text-[11px] text-[#718073] truncate"
                            title={c.Image}
                          >
                            {c.Image}
                          </div>

                          {networks.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1 text-[11px]">
                              <span className="text-[11px] text-[#7a857c]">{t('네트워크')}:</span>
                              {networks.map((net) => (
                                <span
                                  key={net}
                                  className="rounded-[4px] bg-[#eef3ec] px-1.5 py-0.5 font-mono text-[10px] text-[#4d6650]"
                                >
                                  {net}
                                </span>
                              ))}
                            </div>
                          )}

                          {ports.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="text-[11px] text-[#7a857c]">{t('포트')}:</span>
                              {ports.map((p) => {
                                if (isRemoteEngine())
                                  return (
                                    <span
                                      key={`${p.PublicPort}-${p.PrivatePort}`}
                                      className="font-mono"
                                    >
                                      {p.PublicPort} → {p.PrivatePort} ({t('원격 서버')})
                                    </span>
                                  );
                                const directUrl = `http://localhost:${p.PublicPort}`;
                                const vhostUrl = `http://${subDomain}.naru.localhost:${window.location.port || '49170'}`;
                                return (
                                  <div
                                    key={`${p.PublicPort}-${p.PrivatePort}`}
                                    className="flex items-center gap-1"
                                  >
                                    <a
                                      href={directUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-0.5 rounded-[4px] border border-[#d2ddd0] bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-brand hover:underline"
                                      title={t('직접 접속')}
                                    >
                                      :{p.PublicPort}
                                      <ArrowUpRight size={11} />
                                    </a>
                                    <IconButton
                                      icon={Globe}
                                      label={t('{0} 가상 도메인으로 열기', [vhostUrl])}
                                      onClick={() =>
                                        window.open(vhostUrl, '_blank', 'noopener,noreferrer')
                                      }
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-[11px] text-[#9aa29b]">
                              {t('외부 포트 매핑 없음')}
                            </div>
                          )}
                        </div>

                        <div className="mt-3 flex items-center justify-end border-t border-[#edf1ea] pt-2">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline"
                            onClick={() => {
                              close();
                              navigate('/containers/' + c.Id);
                            }}
                          >
                            {t('컨테이너 상세')}
                            <ArrowUpRight size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              {!ready && (
                <p className={tw.groupText}>
                  {' '}
                  {t(
                    'compose 파일을 찾을 수 없어 컨테이너 시작, 정지, 재시작만 할 수 있습니다.',
                  )}{' '}
                </p>
              )}
              {managed ? (
                <label
                  className={cn(
                    tw.field,
                    'my-0 [&_textarea]:min-h-[320px] [&_textarea]:font-mono [&_textarea]:text-[12px]',
                  )}
                >
                  <span>compose.yaml</span>
                  <textarea
                    spellCheck={false}
                    value={yaml}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                </label>
              ) : (
                detail.data.files
                  .filter((f) => f.text !== null)
                  .map((f) => (
                    <section key={f.path} className="flex flex-col gap-2">
                      <span className="font-mono text-[11px] text-muted">{f.path}</span>
                      <pre className={tw.jsonView}>{f.text}</pre>
                    </section>
                  ))
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function Containers() {
  const locale = useLocale();
  const { status, job, form, confirm, busy } = useActions(),
    data = useResource('containers'),
    navigate = useNavigate();
  const projects = useData('projects', '/projects', {
    enabled: !!status?.ready,
    refetchInterval: (status?.pollSeconds || 5) * 1000,
  });
  const [search, setSearch] = useState(''),
    [tab, setTab] = useState('all'),
    [showSystem, setShowSystem] = useState(false),
    [collapsedState, setCollapsedState] = useState(readCollapsedState),
    [logProject, setLogProject] = useState(null),
    [manageGroup, setManageGroup] = useState(null),
    [createModal, setCreateModal] = useState(false),
    [cloneTarget, setCloneTarget] = useState(null),
    [selectedIds, setSelectedIds] = useState(() => new Set());
  // Kubernetes를 쓰지 않으면 숨길 시스템 컨테이너가 없으므로 표시 선택도 보이지 않는다.
  const hasSystem = useMemo(() => (data.data || []).some(isSystemContainer), [data.data]);
  const systemToggle = !!status?.kubernetes?.enabled || hasSystem;
  const candidates = useMemo(
    () => (data.data || []).filter((r) => showSystem || !isSystemContainer(r)),
    [data.data, showSystem],
  );
  const visible = useMemo(
    () => candidates.filter((r) => JSON.stringify(r).toLowerCase().includes(search.toLowerCase())),
    [candidates, search],
  );
  const inTab = (r, key) =>
    key === 'all' || (key === 'running' ? r.State === 'running' : r.State !== 'running');
  // 프로젝트 머리 행 다음에 소속 컨테이너가 오도록 행을 만든다. 실행 수는 탭이나 검색과 무관하게 센다.
  const rows = useMemo(() => {
    const projectOf = (r) =>
      r.Labels?.[PROJECT_LABEL] ||
      (r.Labels?.['coolify.managed'] === 'true' ? COOLIFY_UTIL : NO_PROJECT);
    const infos = new Map((projects.data || []).map((p) => [p.name, p]));
    const all = new Map();
    for (const r of candidates) {
      const key = projectOf(r);
      if (!all.has(key)) all.set(key, []);
      all.get(key).push(r);
    }
    const keys = new Set(all.keys());
    if (tab !== 'running' && !search) for (const name of infos.keys()) keys.add(name);
    // 실행 중인 컨테이너가 있는 프로젝트를 먼저, 같은 조건에서는 이름순으로 둔다.
    const live = (key) => (all.get(key) || []).some((r) => r.State === 'running');
    const ordered = [...keys].sort(
      (a, b) => live(b) - live(a) || (a === NO_PROJECT) - (b === NO_PROJECT) || a.localeCompare(b),
    );
    const shown = visible
      .filter((r) => inTab(r, tab))
      .sort(
        (a, b) =>
          (b.State === 'running') - (a.State === 'running') ||
          containerName(a).localeCompare(containerName(b)),
      );
    const result = [];
    for (const key of ordered) {
      const members = all.get(key) || [];
      result.push({
        __group: key,
        virtual: key === COOLIFY_UTIL,
        __keepEmpty: members.length === 0,
        Id: 'project:' + key,
        info: infos.get(key),
        total: members.length,
        running: members.filter((r) => r.State === 'running').length,
      });
      for (const r of shown) if (projectOf(r) === key) result.push({ ...r, __groupKey: key });
    }
    return result;
  }, [candidates, visible, projects.data, tab, search]);
  const collapsed = useMemo(() => {
    const set = new Set();
    for (const r of rows) {
      if (r.__group !== undefined) {
        const key = r.__group;
        const isCollapsed =
          collapsedState[key] !== undefined ? collapsedState[key] : r.running === 0;
        if (isCollapsed) set.add(key);
      }
    }
    return set;
  }, [rows, collapsedState]);
  const toggle = useCallback(
    (key) =>
      setCollapsedState((current) => {
        const currentlyCollapsed = collapsed.has(key);
        const next = { ...current, [key]: !currentlyCollapsed };
        try {
          localStorage.setItem(engineStorageKey(COLLAPSED_KEY), JSON.stringify(next));
        } catch {}
        return next;
      }),
    [collapsed],
  );
  const projectContext = useMemo(
    () => ({
      job,
      confirm,
      busy,
      collapsed,
      toggle,
      openLogs: setLogProject,
      openManage: setManageGroup,
    }),
    [job, confirm, busy, collapsed, toggle],
  );
  const cols = useMemo(
    () => [
      {
        headerName: '',
        colId: 'selection',
        width: 44,
        minWidth: 44,
        maxWidth: 44,
        sortable: false,
        headerComponent: () => {
          const selectableIds = candidates.map((c) => c.Id).filter(Boolean);
          const allChecked =
            selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
          return (
            <div className="flex h-full items-center justify-center">
              <input
                type="checkbox"
                className="cursor-pointer"
                aria-label={t('전체 선택')}
                checked={allChecked}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(selectableIds));
                  else setSelectedIds(new Set());
                }}
              />
            </div>
          );
        },
        cellRenderer: ({ data: r }) => {
          if (r.__group !== undefined) return null;
          const checked = selectedIds.has(r.Id);
          return (
            <div
              className="flex h-full items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                className="cursor-pointer"
                aria-label={`${containerName(r)} 선택`}
                checked={checked}
                onChange={() => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.Id)) next.delete(r.Id);
                    else next.add(r.Id);
                    return next;
                  });
                }}
              />
            </div>
          );
        },
      },
      {
        headerName: t('컨테이너'),
        colId: 'name',
        width: 250,
        minWidth: 200,
        valueGetter: ({ data: r }) => containerName(r),
        cellRenderer: ({ data: r }) => (
          <div className={cn(tw.nameCell, 'pl-7 max-tablet:pl-4')}>
            <Box size={19} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <strong className="truncate">{containerName(r)}</strong>
                <CopyButton
                  text={containerName(r)}
                  label={t('{0} 이름 복사', [containerName(r)])}
                />
              </div>
              <div className="flex items-center gap-1 text-[11px] text-[#8c978e]">
                <small>{r.Id?.slice(0, 12)}</small>
                <CopyButton
                  text={r.Id?.slice(0, 12)}
                  label={t('{0} ID 복사', [containerName(r)])}
                />
              </div>
            </div>
          </div>
        ),
      },
      {
        field: 'State',
        headerName: t('상태'),
        width: 85,
        minWidth: 85,
        maxWidth: 95,
        cellRenderer: ({ value }) => <Badge state={value} />,
      },
      { field: 'Image', headerName: t('이미지'), width: 230, minWidth: 180, filterable: true },
      {
        headerName: t('포트'),
        minWidth: 220,
        flex: 1,
        valueGetter: ({ data: r }) =>
          publicPortMappings(r.Ports)
            .map((p) => `${p.PublicPort} → ${p.PrivatePort}`)
            .join(', ') || '-',
        cellRenderer: ({ data: r }) => {
          const publicPorts = publicPortMappings(r.Ports);
          if (!publicPorts.length) return <span className="text-[#8c978e]">-</span>;
          return (
            <div
              className="flex flex-wrap items-center gap-2 py-1 leading-normal"
              onClick={(e) => e.stopPropagation()}
            >
              {publicPorts.map((p, idx) => {
                if (isRemoteEngine())
                  return (
                    <span key={idx} className="font-mono text-xs">
                      {p.PublicPort} → {p.PrivatePort} ({t('원격 서버')})
                    </span>
                  );
                const url = `http://127.0.0.1:${p.PublicPort}`;
                const naruPort = window.location.port ? `:${window.location.port}` : '';
                const virtualUrl = `http://${containerName(r).toLowerCase()}.naru.localhost${naruPort}`;
                return (
                  <div key={idx} className="inline-flex items-center gap-1.5 text-[12px]">
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      data-no-row-click="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.__naru_no_row_click = Date.now();
                      }}
                      className="inline-flex items-center gap-0.5 font-mono text-[#2c6e49] underline decoration-[#2c6e49]/30 hover:decoration-[#2c6e49]"
                      title={t('{0} 브라우저에서 열기', [url])}
                    >
                      <span>{`${p.PublicPort} → ${p.PrivatePort}`}</span>
                      <ArrowUpRight size={13} className="flex-none opacity-70" />
                    </a>
                    <IconButton
                      icon={Globe}
                      label={t('{0} 가상 도메인으로 열기', [virtualUrl])}
                      data-no-row-click="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.__naru_no_row_click = Date.now();
                        window.open(virtualUrl, '_blank', 'noopener,noreferrer');
                      }}
                    />
                  </div>
                );
              })}
            </div>
          );
        },
      },
      {
        headerName: '',
        colId: 'actions',
        width: 175,
        minWidth: 175,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <div className={tw.rowActions} onClick={(e) => e.stopPropagation()}>
            <IconButton
              icon={r.State === 'running' ? Square : Play}
              label={`${containerName(r)} ${r.State === 'running' ? t('중지') : t('시작')}`}
              disabled={busy}
              onClick={() =>
                job('containerAction', {
                  id: r.Id,
                  action: r.State === 'running' ? 'stop' : 'start',
                })
              }
            />
            <IconButton
              icon={Terminal}
              label={t('{0} 로그 보기', [containerName(r)])}
              onClick={() => navigate('/containers/' + r.Id + '?tab=logs')}
            />
            <IconButton
              icon={Copy}
              label={t('{0} 설정 복제', [containerName(r)])}
              disabled={busy}
              onClick={async () => {
                try {
                  const inspect = await api('/containers/' + r.Id + '/inspect');
                  const data = Array.isArray(inspect) ? inspect[0] : inspect;
                  const cfg = data.Config || {};
                  const hostConfig = data.HostConfig || {};
                  const portBindings = hostConfig.PortBindings || {};
                  const portsStr = Object.entries(portBindings)
                    .map(([cPort, bindings]) => {
                      const p = bindings?.[0]?.HostPort;
                      const target = cPort.split('/')[0];
                      const nextPort = Number(p) ? Number(p) + 1 : p;
                      return p ? `${nextPort}:${target}` : '';
                    })
                    .filter(Boolean)
                    .join(', ');
                  const mountsStr = (data.Mounts || [])
                    .map(
                      (m) => `${m.Source || m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`,
                    )
                    .join('\n');
                  const envStr = (cfg.Env || []).filter((e) => !e.startsWith('PATH=')).join('\n');
                  const cmdStr = Array.isArray(cfg.Cmd) ? cfg.Cmd.join(' ') : cfg.Cmd || '';

                  setCloneTarget({
                    image: cfg.Image || r.Image,
                    name: `${containerName(r)}-clone`,
                    ports: portsStr,
                    env: envStr,
                    mounts: mountsStr,
                    command: cmdStr,
                  });
                  setCreateModal(true);
                } catch (e) {
                  notify(e);
                }
              }}
            />
            <IconButton
              icon={Trash2}
              label={t('{0} 삭제', [containerName(r)])}
              danger="row"
              disabled={busy}
              onClick={() =>
                confirm(
                  t('컨테이너 삭제'),
                  t('{0} 컨테이너를 삭제합니다. 연결된 볼륨은 보존됩니다.', [containerName(r)]),
                  () => job('containerAction', { id: r.Id, action: 'remove' }),
                )
              }
            />
          </div>
        ),
      },
    ],
    [locale, busy, job, confirm, navigate, selectedIds, candidates],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label={t('미사용 리소스 정리')}
          icon={BrushCleaning}
          disabled={busy}
          onClick={() =>
            confirm(
              t('미사용 리소스 정리'),
              t(
                '중지된 컨테이너, 태그 없는 이미지와 미사용 네트워크를 일괄 삭제하여 가상 디스크 용량을 확보합니다. 볼륨 데이터는 유지됩니다.',
              ),
              () => job('pruneResources', { all: true, volumes: false }),
            )
          }
        />
        <PageAction
          label={t('새 Compose 프로젝트')}
          icon={FolderPlus}
          disabled={busy}
          onClick={() =>
            form(
              t('새 Compose 프로젝트'),
              [
                {
                  key: 'name',
                  label: t('프로젝트 이름'),
                  required: true,
                  placeholder: 'my-app',
                  hint: t('영문 소문자, 숫자, -, _만 사용합니다.'),
                },
                {
                  key: 'yaml',
                  label: 'compose.yaml',
                  type: 'textarea',
                  rows: 14,
                  required: true,
                  value: composeExample,
                },
              ],
              (v) => job('compose', { name: v.name, yaml: v.yaml, action: 'up' }),
              t('Naru 데이터 폴더에 저장하고 바로 up합니다.'),
            )
          }
        />
        <PageAction
          label={t('컨테이너 실행')}
          icon={Plus}
          primary
          disabled={busy}
          onClick={() => setCreateModal(true)}
        />
      </PageActions>
      <div className={tw.gridPanel}>
        <div className="flex items-center justify-between border-b border-line px-5 max-tablet:px-3">
          <div className="flex gap-5.5 overflow-x-auto">
            {[
              ['all', t('전체')],
              ['running', t('실행 중')],
              ['stopped', t('종료됨')],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={tab === key}
                className={cn(tw.tab, tab === key && tw.tabSelected)}
                onClick={() => setTab(key)}
              >
                {label}
                <span>{visible.filter((r) => inTab(r, key)).length}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 py-2">
            <div className="flex h-8.5 w-56 items-center gap-2 rounded-[6px] border border-[#e3e8df] bg-[#fcfdfb] px-2.5 text-[#8c978e] max-tablet:w-40">
              <Search size={15} />
              <input
                className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-0 placeholder:text-[#9aa29b]"
                aria-label={t('목록 검색')}
                placeholder={t('이름, 이미지, ID 검색')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <IconButton label={t('검색 지우기')} icon={X} onClick={() => setSearch('')} />
              )}
            </div>
            {systemToggle && !selectedIds.size && (
              <label
                className={cn(tw.checkbox, 'whitespace-nowrap py-0 text-[12px] max-tablet:hidden')}
              >
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={(e) => setShowSystem(e.target.checked)}
                />{' '}
                {t('시스템')}
              </label>
            )}
          </div>
        </div>
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#d6e5cd] bg-[#f0f6ec] px-5 py-2 text-[12px] text-[#345c2f]">
            <div className="flex flex-wrap items-center gap-1.5">
              <strong className="font-semibold">{t('{0}대 선택', [selectedIds.size])}</strong>
              <Button
                compact
                icon={Play}
                disabled={busy}
                onClick={async () => {
                  for (const id of selectedIds) {
                    await job('containerAction', { id, action: 'start' });
                  }
                  setSelectedIds(new Set());
                }}
              >
                {t('일괄 시작')}
              </Button>
              <Button
                compact
                icon={Square}
                disabled={busy}
                onClick={async () => {
                  for (const id of selectedIds) {
                    await job('containerAction', { id, action: 'stop' });
                  }
                  setSelectedIds(new Set());
                }}
              >
                {t('일괄 중지')}
              </Button>
              <Button
                compact
                icon={Trash2}
                disabled={busy}
                className="border-danger/30 text-danger hover:border-danger hover:bg-[#faeeeb]"
                onClick={() => {
                  confirm(
                    t('선택한 컨테이너 일괄 삭제'),
                    t('선택한 {0}개 컨테이너를 삭제합니다. 연결된 볼륨은 보존됩니다.', [
                      selectedIds.size,
                    ]),
                    async () => {
                      for (const id of selectedIds) {
                        await job('containerAction', { id, action: 'remove' });
                      }
                      setSelectedIds(new Set());
                    },
                  );
                }}
              >
                {t('일괄 삭제')}
              </Button>
              <Button compact onClick={() => setSelectedIds(new Set())}>
                {t('선택 해제')}
              </Button>
            </div>
            {systemToggle && (
              <label className={cn(tw.checkbox, 'whitespace-nowrap py-0 text-[12px]')}>
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={(e) => setShowSystem(e.target.checked)}
                />{' '}
                {t('시스템 컨테이너 표시')}
              </label>
            )}
          </div>
        )}
        <ProjectContext.Provider value={projectContext}>
          <ResourceGrid
            query={{ ...data, data: rows }}
            columns={cols}
            collapsedGroups={collapsed}
            fullWidthCellRenderer={ProjectRow}
            onRowClicked={(params) => {
              const r = params.data;
              if (!r || r.__group !== undefined) return;

              // 최근 400ms 이내에 버튼, 복사 버튼, 링크를 클릭한 경우 차단
              if (Date.now() - (window.__naru_no_row_click || 0) < 400) return;

              // 포트 열, 액션 열, 선택 체크박스 열 클릭은 상세 이동 차단
              const colId = params.column?.getColId?.();
              if (colId === 'ports' || colId === 'actions' || colId === 'selection') return;

              // 클릭 경로 중 인터랙티브 요소가 있으면 차단
              const nativeEvt = params.event;
              if (nativeEvt) {
                const path = nativeEvt.composedPath?.() || [];
                const isInteractive = path.some(
                  (el) =>
                    el instanceof HTMLElement &&
                    (el.tagName === 'BUTTON' ||
                      el.tagName === 'A' ||
                      el.tagName === 'INPUT' ||
                      el.hasAttribute('data-no-row-click') ||
                      el.closest?.('button, a, input, [data-no-row-click]')),
                );
                if (isInteractive) return;
                if (nativeEvt.target?.closest?.('button, a, input, [data-no-row-click]')) return;
              }

              navigate('/containers/' + r.Id);
            }}
          />
        </ProjectContext.Provider>
      </div>
      {logProject && <ProjectLogs name={logProject} onClose={() => setLogProject(null)} />}
      {manageGroup && (
        <ProjectManage
          group={manageGroup}
          onClose={() => setManageGroup(null)}
          onLogs={setLogProject}
          containers={candidates}
        />
      )}
      <CreateContainerModal
        isOpen={createModal}
        initialValues={cloneTarget}
        onClose={() => {
          setCreateModal(false);
          setCloneTarget(null);
        }}
        busy={busy}
        onSubmit={async (payload) => {
          await job('createContainer', payload);
          setCreateModal(false);
          setCloneTarget(null);
        }}
      />
    </section>
  );
}
export default Containers;
