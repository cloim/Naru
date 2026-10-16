import { t, useLocale } from '../i18n.js';
import React, { createContext, useContext, useMemo, useState } from 'react';
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
} from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  IconButton,
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
import { Modal } from '../components/Modal/Modal.jsx';

export const isSystemContainer = (r) =>
  Boolean(
    r.Labels?.['io.kubernetes.pod.name'] ||
    r.Labels?.['io.kubernetes.container.name'] ||
    (r.Names || []).some((name) => /^\/?k8s_/.test(name)),
  );
const PROJECT_LABEL = 'com.docker.compose.project';
const NO_PROJECT = '';
const COLLAPSED_KEY = 'naru.collapsedProjects';
const composeExample =
  'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n';

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

// 프로젝트 머리 행은 그리드 셀 렌더러 안에서 그려지므로 화면 동작을 context로 전달한다.
const ProjectContext = createContext(null);

function ProjectRow({ data: g }) {
  useLocale();
  const { job, busy, toggle, collapsed, openLogs, openManage } = useContext(ProjectContext);
  const open = !collapsed.has(g.__group);
  const named = g.__group !== NO_PROJECT;
  const run = (action) => job('project', { name: g.__group, action });
  return (
    <div
      className="flex h-full cursor-pointer items-center gap-3 border-b border-line bg-[#f6f8f2] pr-3 pl-3.5 max-tablet:gap-2 max-tablet:pl-2.5"
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
          {named ? g.__group : t('프로젝트 없음')}
        </strong>
        <small className="truncate font-mono text-[10px] text-[#9aa297]">
          {named
            ? g.info?.workingDir || t('작업 폴더 정보 없음')
            : t('Compose로 만들지 않은 컨테이너')}
        </small>
      </div>
      <Badge state={g.running > 0 ? 'running' : 'exited'}>
        {g.total ? t('실행 {0}/{1}', [g.running, g.total]) : t('컨테이너 없음')}
      </Badge>
      {named && (
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
        </div>
      )}
    </div>
  );
}

function ProjectLogs({ name, onClose }) {
  useLocale();
  const logs = useData('project-logs:' + name, `/projects/${name}/logs`, {
    enabled: !!name,
    refetchInterval: name ? 5000 : false,
  });
  return (
    <Modal
      isOpen={!!name}
      title={t('{0} 프로젝트 로그', [name || ''])}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button icon={RefreshCw} disabled={logs.isFetching} onClick={() => logs.refetch()}>
            {' '}
            {t('새로고침')}{' '}
          </Button>
          <Button onClick={onClose}>{t('닫기')}</Button>
        </>
      }
    >
      {logs.isLoading ? (
        <Skeleton />
      ) : logs.error ? (
        <ErrorState error={logs.error} retry={() => logs.refetch()} />
      ) : (
        <pre className={tw.terminal} aria-label={t('프로젝트 로그')}>
          {logs.data?.text || t('아직 출력된 로그가 없습니다.')}
        </pre>
      )}
    </Modal>
  );
}

function ProjectManage({ group, onClose, onLogs }) {
  useLocale();
  const { job, confirm, notify, busy } = useActions(),
    qc = useQueryClient();
  const name = group?.__group;
  const detail = useData('project-files:' + name, `/projects/${name}/files`, { enabled: !!name });
  const [draft, setDraft] = useState(null);
  const managed = detail.data?.managed;
  const yaml = draft ?? detail.data?.files?.[0]?.text ?? '';
  const close = () => {
    setDraft(null);
    onClose();
  };
  const run = (action) => job('project', { name, action }).then(close);
  const ready = !!detail.data?.filesFound;
  return (
    <Modal
      isOpen={!!name}
      title={t('{0} 프로젝트 관리', [name || ''])}
      onClose={close}
      size="lg"
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
          {group?.total === 0 && (
            <Button
              icon={Trash2}
              disabled={busy}
              onClick={() => {
                close();
                confirm(
                  t('프로젝트를 목록에서 제거'),
                  managed
                    ? t('{0} 프로젝트와 Naru에 저장한 compose.yaml을 삭제합니다.', [name])
                    : t('{0} 프로젝트를 목록에서 뺍니다. 원본 compose 파일은 그대로 둡니다.', [
                        name,
                      ]),
                  () =>
                    api(`/projects/${name}`, { method: 'DELETE' })
                      .then(() => qc.invalidateQueries({ queryKey: ['projects'] }))
                      .catch(notify),
                );
              }}
            >
              {' '}
              {t('목록에서 제거')}{' '}
            </Button>
          )}
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
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[12px] [&_dd]:font-mono [&_dd]:break-all [&_dt]:font-semibold [&_dt]:text-[#536454]">
            <dt>{t('작업 폴더')}</dt>
            <dd>{detail.data.workingDir}</dd>
            <dt>{t('compose 파일')}</dt>
            <dd>{detail.data.configFiles.join(', ') || t('없음')}</dd>
          </dl>
          {!ready && (
            <p className={tw.groupText}>
              {' '}
              {t('compose 파일을 찾을 수 없어 컨테이너 시작, 정지, 재시작만 할 수 있습니다.')}{' '}
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
    [collapsed, setCollapsed] = useState(readCollapsed),
    [logProject, setLogProject] = useState(null),
    [manageGroup, setManageGroup] = useState(null);
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
    const projectOf = (r) => r.Labels?.[PROJECT_LABEL] || NO_PROJECT;
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
  const projectContext = useMemo(
    () => ({
      job,
      busy,
      collapsed,
      toggle: (key) =>
        setCollapsed((current) => {
          const next = new Set(current);
          next.has(key) ? next.delete(key) : next.add(key);
          try {
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
          } catch {}
          return next;
        }),
      openLogs: setLogProject,
      openManage: setManageGroup,
    }),
    [job, busy, collapsed],
  );
  const cols = useMemo(
    () => [
      {
        headerName: t('컨테이너'),
        colId: 'name',
        minWidth: 210,
        flex: 1.3,
        valueGetter: ({ data: r }) => containerName(r),
        cellRenderer: ({ data: r }) => (
          <div className={cn(tw.nameCell, 'pl-7 max-tablet:pl-4')}>
            <Box size={19} />
            <div>
              <strong>{containerName(r)}</strong>
              <small>{r.Id?.slice(0, 12)}</small>
            </div>
          </div>
        ),
      },
      {
        field: 'State',
        headerName: t('상태'),
        width: 125,
        cellRenderer: ({ value }) => <Badge state={value} />,
      },
      { field: 'Image', headerName: t('이미지'), minWidth: 190, flex: 1.2, filterable: true },
      {
        headerName: t('포트'),
        minWidth: 140,
        flex: 0.8,
        valueGetter: ({ data: r }) =>
          r.Ports?.filter((p) => p.PublicPort)
            .map((p) => `${p.PublicPort} → ${p.PrivatePort}`)
            .join(', ') || '—',
      },
      {
        headerName: '',
        colId: 'actions',
        width: 154,
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
              onClick={() => navigate('/containers/' + r.Id)}
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
    [locale, busy, job, confirm, navigate],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  return (
    <section className={tw.page}>
      <PageActions>
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
          onClick={() =>
            form(
              t('컨테이너 실행'),
              [
                { key: 'image', label: t('이미지'), required: true, placeholder: 'nginx:alpine' },
                { key: 'name', label: t('이름'), placeholder: 'my-web' },
                {
                  key: 'ports',
                  label: t('포트'),
                  placeholder: '8080:80, 8443:443',
                  hint: t('호스트 포트:컨테이너 포트. Windows의 127.0.0.1에 공개합니다.'),
                },
                {
                  key: 'env',
                  label: t('환경 변수'),
                  type: 'textarea',
                  rows: 3,
                  placeholder: 'APP_ENV=development\nLOG_LEVEL=info',
                },
                {
                  key: 'mounts',
                  label: t('볼륨과 마운트 (JSON)'),
                  type: 'textarea',
                  rows: 3,
                  value: '[]',
                  hint: t('예: [{"source":"my-data","target":"/data","readOnly":false}]'),
                },
                { key: 'command', label: t('실행 인수 (JSON)'), value: '[]' },
              ],
              (v) =>
                job('createContainer', {
                  image: v.image,
                  ...(v.name ? { name: v.name } : {}),
                  ports: v.ports
                    ? v.ports.split(',').map((x) => {
                        const [host, container] = x.trim().split(':');
                        return {
                          host: Number(host),
                          container: Number(container),
                          protocol: 'tcp',
                        };
                      })
                    : [],
                  env: v.env.split('\n').filter(Boolean),
                  mounts: JSON.parse(v.mounts),
                  command: JSON.parse(v.command),
                }),
            )
          }
        />
      </PageActions>
      <div className={tw.gridPanel}>
        <div className={tw.tabs}>
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
        <Toolbar search={search} onSearch={setSearch} wrap>
          {systemToggle && (
            <label className={cn(tw.checkbox, 'whitespace-nowrap')}>
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(e) => setShowSystem(e.target.checked)}
              />{' '}
              {t('시스템 컨테이너 표시')}{' '}
            </label>
          )}
        </Toolbar>
        <ProjectContext.Provider value={projectContext}>
          <ResourceGrid
            query={{ ...data, data: rows }}
            columns={cols}
            collapsedGroups={collapsed}
            fullWidthCellRenderer={ProjectRow}
            onRowClicked={({ data: r, event }) => {
              if (r.__group !== undefined || event.target.closest('button')) return;
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
        />
      )}
    </section>
  );
}
export default Containers;
