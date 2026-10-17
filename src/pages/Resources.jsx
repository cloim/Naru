import { t, useLocale } from '../i18n.js';
import React, { createContext, useContext, useMemo, useState } from 'react';
import {
  Boxes,
  ChevronRight,
  Plus,
  Trash2,
  FolderOpen,
  Download,
  Activity,
  Send,
  CheckCircle2,
  XCircle,
  Network as NetworkIcon,
} from 'lucide-react';
import {
  useActions,
  Button,
  IconButton,
  Badge,
  Skeleton,
  RuntimeEmpty,
  useResource,
  ResourceGrid,
  Toolbar,
  PageActions,
  PageAction,
  containerName,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import { ResourceFileExplorer } from '../components/ContainerFileExplorer.jsx';

const PROJECT_LABEL = 'com.docker.compose.project';
const NO_PROJECT = '';
const COLLAPSED_VOLUMES_KEY = 'naru.collapsedVolumeProjects';

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_VOLUMES_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

const VolumeProjectContext = createContext(null);

function VolumeProjectRow({ data: g }) {
  useLocale();
  const { toggle, collapsed } = useContext(VolumeProjectContext);
  const open = !collapsed.has(g.__group);
  const named = g.__group !== NO_PROJECT;
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
          {named ? t('Compose 프로젝트 볼륨') : t('Compose로 만들지 않은 볼륨')}
        </small>
      </div>
      <Badge state="ready">{t('볼륨 {0}개', [g.total])}</Badge>
    </div>
  );
}

function Resources({ kind }) {
  const locale = useLocale();
  const { status, job, form, confirm, busy, notify } = useActions(),
    data = useResource(kind);
  const [search, setSearch] = useState(''),
    [inspect, setInspect] = useState(null),
    [collapsed, setCollapsed] = useState(readCollapsed);

  const containers = useResource('containers');
  const [exploreVolume, setExploreVolume] = useState(null),
    [modalTab, setModalTab] = useState('topology'),
    [pingSource, setPingSource] = useState(''),
    [pingTarget, setPingTarget] = useState(''),
    [pingPort, setPingPort] = useState(''),
    [pingResult, setPingResult] = useState(null),
    [pingBusy, setPingBusy] = useState(false);

  const volume = kind === 'volumes',
    label = volume ? t('볼륨') : t('네트워크');

  const runPing = async () => {
    if (!pingSource || !pingTarget) return;
    setPingBusy(true);
    setPingResult(null);
    try {
      const res = await api('/networks/ping', {
        method: 'POST',
        body: {
          source: pingSource,
          target: pingTarget,
          port: pingPort ? Number(pingPort) : undefined,
        },
      });
      setPingResult(res);
    } catch (e) {
      setPingResult({ ok: false, output: e.message });
    } finally {
      setPingBusy(false);
    }
  };

  const volumeProjectContext = useMemo(
    () => ({
      collapsed,
      toggle: (key) =>
        setCollapsed((current) => {
          const next = new Set(current);
          next.has(key) ? next.delete(key) : next.add(key);
          try {
            localStorage.setItem(COLLAPSED_VOLUMES_KEY, JSON.stringify([...next]));
          } catch {}
          return next;
        }),
    }),
    [collapsed],
  );

  const rows = useMemo(() => {
    const raw = data.data || [];
    if (!volume) {
      return [...raw].sort((a, b) => (a.Name || '').localeCompare(b.Name || '', locale));
    }

    const visible = raw.filter((r) =>
      JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
    );
    const projectOf = (r) => {
      if (r.Labels && typeof r.Labels === 'object' && r.Labels[PROJECT_LABEL]) {
        return r.Labels[PROJECT_LABEL];
      }
      if (typeof r.Labels === 'string' && r.Labels) {
        const match = /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(r.Labels);
        if (match) return match[1];
      }
      return NO_PROJECT;
    };

    const all = new Map();
    for (const r of visible) {
      const key = projectOf(r);
      if (!all.has(key)) all.set(key, []);
      all.get(key).push(r);
    }

    const keys = [...all.keys()].sort(
      (a, b) => (a === NO_PROJECT) - (b === NO_PROJECT) || a.localeCompare(b, locale),
    );

    const result = [];
    for (const key of keys) {
      const members = all.get(key) || [];
      members.sort((a, b) => (a.Name || '').localeCompare(b.Name || '', locale));

      result.push({
        __group: key,
        __keepEmpty: false,
        Id: 'project:' + key,
        Name: key,
        total: members.length,
      });

      for (const r of members) {
        result.push({
          ...r,
          __groupKey: key,
        });
      }
    }
    return result;
  }, [data.data, volume, search, locale]);

  const cols = useMemo(
    () => [
      {
        field: 'Name',
        headerName: t('이름'),
        minWidth: 230,
        flex: 1.4,
        sort: 'asc',
        cellRenderer: ({ value }) => (
          <strong className={volume ? 'pl-7 max-tablet:pl-4' : undefined}>{value}</strong>
        ),
      },
      { field: 'Driver', headerName: t('드라이버'), minWidth: 140, flex: 0.6, filterable: !volume },
      {
        field: volume ? 'Mountpoint' : 'Scope',
        headerName: volume ? t('마운트 경로') : t('범위'),
        minWidth: 210,
        flex: 1.2,
      },
      {
        headerName: '',
        colId: 'actions',
        width: volume ? 160 : 130,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <div className={tw.rowActions} onClick={(e) => e.stopPropagation()}>
            {volume && (
              <>
                <IconButton
                  icon={FolderOpen}
                  label={t('{0} 파일 탐색', [r.Name])}
                  disabled={busy}
                  onClick={() => setExploreVolume(r.Name)}
                />
                <IconButton
                  icon={Download}
                  label={t('{0} 백업 다운로드 (.tar.gz)', [r.Name])}
                  disabled={busy}
                  onClick={() =>
                    window.open(`/api/volumes/${encodeURIComponent(r.Name)}/export`, '_blank')
                  }
                />
              </>
            )}
            {!volume && (
              <IconButton
                icon={Activity}
                label={t('{0} 통신 진단 (Ping)', [r.Name])}
                disabled={busy}
                onClick={async () => {
                  try {
                    const res = await api(`/networks/${encodeURIComponent(r.Id)}/inspect`);
                    const net = Array.isArray(res) ? res[0] : res;
                    setInspect(net);
                    setModalTab('topology');
                    const firstContainer = Object.keys(net?.Containers || {})[0];
                    if (firstContainer) {
                      setPingSource(firstContainer);
                    }
                  } catch (e) {
                    notify(e);
                  }
                }}
              />
            )}
            <IconButton
              icon={Trash2}
              label={t(volume ? '볼륨 삭제' : '네트워크 삭제')}
              danger
              disabled={busy}
              onClick={() =>
                confirm(
                  t(volume ? '볼륨 삭제' : '네트워크 삭제'),
                  t(
                    volume
                      ? '{0}에 저장된 데이터도 함께 삭제됩니다.'
                      : '{0} 네트워크를 삭제합니다.',
                    [r.Name],
                  ),
                  () =>
                    job(
                      volume ? 'removeVolume' : 'removeNetwork',
                      volume ? { name: r.Name } : { id: r.Id },
                    ),
                )
              }
            />
          </div>
        ),
      },
    ],
    [locale, volume, label, busy, confirm, job, notify],
  );

  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;

  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label={t(volume ? '볼륨 생성' : '네트워크 생성')}
          primary
          icon={Plus}
          disabled={busy}
          onClick={() =>
            form(
              t(volume ? '볼륨 생성' : '네트워크 생성'),
              [{ key: 'name', label: t('이름'), required: true }],
              (v) => job(volume ? 'createVolume' : 'createNetwork', v),
            )
          }
        />
      </PageActions>
      <div className={tw.gridPanel}>
        <Toolbar search={search} onSearch={setSearch} />
        {volume ? (
          <VolumeProjectContext.Provider value={volumeProjectContext}>
            <ResourceGrid
              query={{ ...data, data: rows }}
              columns={cols}
              collapsedGroups={collapsed}
              fullWidthCellRenderer={VolumeProjectRow}
              onRowClicked={async ({ data: r, event }) => {
                if (r.__group !== undefined || event.target.closest('button')) return;
                try {
                  const inspected = await api(`/${kind}/${encodeURIComponent(r.Name)}/inspect`);
                  setInspect(Array.isArray(inspected) ? inspected[0] : inspected);
                } catch (e) {
                  notify(e);
                }
              }}
            />
          </VolumeProjectContext.Provider>
        ) : (
          <ResourceGrid
            query={{ ...data, data: rows }}
            columns={cols}
            filter={search}
            onRowClicked={async ({ data: r, event }) => {
              if (event.target.closest('button')) return;
              try {
                const inspected = await api(`/${kind}/${encodeURIComponent(r.Id)}/inspect`);
                const net = Array.isArray(inspected) ? inspected[0] : inspected;
                setInspect(net);
                setModalTab('topology');
                const firstContainer = Object.keys(net?.Containers || {})[0];
                if (firstContainer) {
                  setPingSource(firstContainer);
                }
              } catch (e) {
                notify(e);
              }
            }}
          />
        )}
      </div>

      {inspect && (
        <Modal
          isOpen={!!inspect}
          onClose={() => {
            setInspect(null);
            setPingResult(null);
          }}
          title={t('{0} 구성 및 진단', [inspect?.Name || label])}
          size={volume ? 'lg' : 'xl'}
          resizable
          storageKey="resource-inspect"
          footer={<Button onClick={() => setInspect(null)}>{t('닫기')}</Button>}
        >
          {!volume ? (
            <div className="flex flex-col gap-4">
              <div className="flex border-b border-[#e3e8df]">
                <button
                  type="button"
                  onClick={() => setModalTab('topology')}
                  className={cn(
                    'flex items-center gap-2 border-b-2 px-4 py-2 text-[13px] font-semibold transition-colors',
                    modalTab === 'topology'
                      ? 'border-brand text-brand'
                      : 'border-transparent text-[#7a857c] hover:text-ink',
                  )}
                >
                  <NetworkIcon size={15} />
                  {t('연결 토폴로지 및 통신 점검')}
                </button>
                <button
                  type="button"
                  onClick={() => setModalTab('inspect')}
                  className={cn(
                    'flex items-center gap-2 border-b-2 px-4 py-2 text-[13px] font-semibold transition-colors',
                    modalTab === 'inspect'
                      ? 'border-brand text-brand'
                      : 'border-transparent text-[#7a857c] hover:text-ink',
                  )}
                >
                  {t('구성 (JSON)')}
                </button>
              </div>

              {modalTab === 'topology' ? (
                <div className="flex flex-col gap-4">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[12px] [&_dd]:font-mono [&_dd]:break-all [&_dt]:font-semibold [&_dt]:text-[#536454]">
                    <dt>{t('네트워크 드라이버')}</dt>
                    <dd>{inspect.Driver || '-'}</dd>
                    <dt>{t('서브넷 및 게이트웨이')}</dt>
                    <dd>
                      {inspect.IPAM?.Config?.[0]?.Subnet
                        ? `${inspect.IPAM.Config[0].Subnet} (GW: ${inspect.IPAM.Config[0].Gateway || '-'})`
                        : t('없음')}
                    </dd>
                  </dl>

                  <div>
                    <h4 className="mb-2 text-[12px] font-semibold text-[#536454]">
                      {t('연결된 컨테이너 ({0}대)', [Object.keys(inspect.Containers || {}).length])}
                    </h4>
                    {Object.keys(inspect.Containers || {}).length === 0 ? (
                      <div className="rounded-[7px] border border-dashed border-[#dce4d6] p-4 text-center text-[12px] text-muted">
                        {t('이 네트워크에 연결된 컨테이너가 없습니다.')}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {Object.entries(inspect.Containers || {}).map(([cid, info]) => (
                          <div
                            key={cid}
                            className="flex items-center justify-between rounded-[7px] border border-[#dce4d6] bg-[#fbfcf9] p-3 text-[12px]"
                          >
                            <div className="min-w-0 flex-1">
                              <strong className="block truncate text-ink">{info.Name}</strong>
                              <div className="mt-0.5 flex flex-wrap gap-2 font-mono text-[11px] text-[#718073]">
                                <span>IP: {info.IPv4Address || '-'}</span>
                                <span className="text-[#9aa297]">
                                  MAC: {info.MacAddress || '-'}
                                </span>
                              </div>
                            </div>
                            <Button
                              compact
                              className="ml-2 text-[11px]"
                              onClick={() => {
                                setPingSource(cid);
                              }}
                            >
                              {t('출발지 선택')}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-[8px] border border-[#dce4d6] bg-[#fdfefb] p-4">
                    <h4 className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                      <Activity size={15} className="text-brand" />
                      {t('통신 핑(Ping) 및 포트 점검')}
                    </h4>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#536454]">
                        <span>{t('출발지 컨테이너')}</span>
                        <select
                          value={pingSource}
                          onChange={(e) => setPingSource(e.target.value)}
                          className="h-8.5 rounded-[6px] border border-[#dce2d9] bg-white px-2 font-mono text-[12px] text-ink"
                        >
                          <option value="">{t('컨테이너 선택…')}</option>
                          {(containers.data || [])
                            .filter((c) => c.State === 'running')
                            .map((c) => (
                              <option key={c.Id} value={c.Id}>
                                {containerName(c)}
                              </option>
                            ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#536454]">
                        <span>{t('목적지 (호스트/컨테이너 IP/이름)')}</span>
                        <input
                          value={pingTarget}
                          onChange={(e) => setPingTarget(e.target.value)}
                          placeholder="예: database or 172.17.0.2"
                          className="h-8.5 rounded-[6px] border border-[#dce2d9] bg-white px-2 font-mono text-[12px] text-ink"
                        />
                      </label>

                      <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#536454]">
                        <span>{t('포트 (선택 사항)')}</span>
                        <div className="flex gap-2">
                          <input
                            value={pingPort}
                            onChange={(e) => setPingPort(e.target.value)}
                            placeholder="예: 80, 5432"
                            type="number"
                            className="h-8.5 flex-1 rounded-[6px] border border-[#dce2d9] bg-white px-2 font-mono text-[12px] text-ink"
                          />
                          <Button
                            primary
                            compact
                            icon={Send}
                            disabled={pingBusy || !pingSource || !pingTarget}
                            onClick={runPing}
                          >
                            {pingBusy ? t('진단 중…') : t('진단')}
                          </Button>
                        </div>
                      </label>
                    </div>

                    {pingResult && (
                      <div className="mt-3.5">
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold">
                          {pingResult.ok ? (
                            <span className="flex items-center gap-1 text-[#2d6f36]">
                              <CheckCircle2 size={13} />
                              {t('통신 정상')}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-danger">
                              <XCircle size={13} />
                              {t('통신 실패')}
                            </span>
                          )}
                        </div>
                        <pre className={cn(tw.terminal, 'max-h-[160px] min-h-[70px] text-[11px]')}>
                          {pingResult.output || t('결과가 없습니다.')}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <pre className={tw.jsonView}>{JSON.stringify(inspect, null, 2)}</pre>
              )}
            </div>
          ) : (
            <pre className={tw.jsonView}>{JSON.stringify(inspect, null, 2)}</pre>
          )}
        </Modal>
      )}

      {exploreVolume && (
        <Modal
          isOpen
          onClose={() => setExploreVolume(null)}
          title={t('{0} 볼륨 파일 탐색기', [exploreVolume])}
          size="xl"
          footer={<Button onClick={() => setExploreVolume(null)}>{t('닫기')}</Button>}
        >
          <ResourceFileExplorer targetType="volumes" targetId={exploreVolume} />
        </Modal>
      )}
    </section>
  );
}

export default Resources;
