import { t, useLocale, formatDate } from '../i18n.js';
import React, { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  RotateCw,
  Pause,
  Search,
  X,
  ArrowDown,
  TriangleAlert,
  Download,
  Settings2,
} from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  IconButton,
  CopyButton,
  Skeleton,
  ErrorState,
  bytes,
  PageActions,
  PageAction,
  usePageTitle,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { ContainerFileExplorer } from '../components/ContainerFileExplorer.jsx';
import { EditContainerModal } from '../components/EditContainerModal.jsx';
import ResourceChart from '../components/ResourceChart.jsx';
const TerminalPanel = lazy(() => import('../components/TerminalPanel.jsx'));

function InfoSection({ title, rows, autoSizeLabels = false }) {
  return (
    <details open className="border-b border-line last:border-b-0">
      <summary className="cursor-pointer bg-[#f5f8f2] px-5 py-2.5 text-[13px] font-semibold text-ink focus-visible:outline-accent">
        {title}
      </summary>
      <dl
        className={cn(
          'm-0 text-[13px]',
          autoSizeLabels &&
            'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 max-tablet:grid-cols-1',
        )}
      >
        {rows.map(([label, value], index) => (
          <div
            key={index}
            className={cn(
              'grid gap-x-4 gap-y-1 border-t border-line px-5 py-2.5 max-tablet:px-3',
              autoSizeLabels
                ? 'col-span-full grid-cols-subgrid'
                : 'grid-cols-[180px_minmax(0,1fr)] max-tablet:grid-cols-1',
            )}
          >
            <dt
              className={cn('text-muted', autoSizeLabels ? 'whitespace-nowrap' : 'wrap-anywhere')}
            >
              {label}
            </dt>
            <dd className="m-0 min-w-0 whitespace-pre-wrap wrap-anywhere text-ink">
              {value === undefined || value === null || value === '' ? '-' : value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function ContainerGeneral({ inspect }) {
  const config = inspect.Config || {};
  const host = inspect.HostConfig || {};
  const state = inspect.State || {};
  const networks = Object.entries(inspect.NetworkSettings?.Networks || {});
  const command = (value) => (Array.isArray(value) ? value.join(' ') : value);
  const date = (value) => (value && !value.startsWith('0001-') ? formatDate(value) : null);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t('컨테이너 일반 정보')}>
      <InfoSection
        title={t('일반')}
        rows={[
          [t('컨테이너 이름'), inspect.Name?.replace(/^\//, '')],
          ['ID', inspect.Id],
          [t('이미지 이름'), config.Image],
          [t('상태'), state.Paused ? t('일시 정지') : state.Running ? t('실행 중') : state.Status],
          [t('만든 시간'), date(inspect.Created)],
          [t('시작 시간'), date(state.StartedAt)],
          [t('프로젝트'), config.Labels?.['com.docker.compose.project']],
          [
            t('CPU 제한'),
            host.NanoCpus > 0
              ? `${host.NanoCpus / 1e9} CPU`
              : host.CpuQuota > 0
                ? `${(host.CpuQuota / (host.CpuPeriod || 100000)).toFixed(2)} CPU`
                : t('무제한'),
          ],
          [t('CPU 가중치'), host.CpuShares || t('자동')],
          [t('메모리 제한'), host.Memory > 0 ? bytes(host.Memory) : t('무제한')],
          [t('자동 재시작 정책'), host.RestartPolicy?.Name || t('없음')],
          [
            t('포트'),
            Object.entries(inspect.NetworkSettings?.Ports || {})
              .map(([port, bindings]) =>
                bindings?.length
                  ? bindings
                      .map(
                        (binding) => `${binding.HostIp || '0.0.0.0'}:${binding.HostPort} → ${port}`,
                      )
                      .join('\n')
                  : port,
              )
              .join('\n'),
          ],
        ]}
      />
      <InfoSection
        title={t('환경 변수')}
        autoSizeLabels
        rows={
          config.Env?.length
            ? config.Env.map((entry) => {
                const separator = entry.indexOf('=');
                return separator < 0
                  ? [entry, '']
                  : [entry.slice(0, separator), entry.slice(separator + 1)];
              })
            : [[t('환경 변수'), t('없음')]]
        }
      />
      <InfoSection
        title={t('네트워크')}
        rows={
          networks.length
            ? networks.flatMap(([name, network]) => [
                [t('네트워크 이름'), name],
                [t('네트워크 모드'), host.NetworkMode],
                [t('MAC 주소'), network.MacAddress],
                [t('게이트웨이'), network.Gateway],
                [t('IP 주소'), network.IPAddress],
                ...(network.GlobalIPv6Address
                  ? [
                      [t('IPv6 주소'), network.GlobalIPv6Address],
                      [t('IPv6 게이트웨이'), network.IPv6Gateway],
                    ]
                  : []),
              ])
            : [[t('네트워크 모드'), host.NetworkMode]]
        }
      />
      <InfoSection
        title={t('실행 명령')}
        rows={[
          [t('실행 명령'), command(config.Cmd)],
          ['Entrypoint', command(config.Entrypoint)],
          [t('작업 디렉터리'), config.WorkingDir],
          [t('사용자'), config.User],
        ]}
      />
    </div>
  );
}

const percent = (value) => `${value.toFixed(1)}%`;
const rate = (value) =>
  value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB/s` : `${(value / 1024).toFixed(1)} KB/s`;

export function resourceUsage(stats) {
  const cpu = stats.cpu_stats,
    previous = stats.precpu_stats;
  const cpuDelta = cpu?.cpu_usage?.total_usage - previous?.cpu_usage?.total_usage;
  const systemDelta = cpu?.system_cpu_usage - previous?.system_cpu_usage;
  const cores = cpu?.online_cpus || cpu?.cpu_usage?.percpu_usage?.length || 1;
  const memory = stats.memory_stats;
  const cache = memory?.stats?.total_inactive_file ?? memory?.stats?.inactive_file ?? 0;
  const used = Number.isFinite(memory?.usage) ? Math.max(0, memory.usage - cache) : null;
  const limit = memory?.limit > 0 ? memory.limit : null;
  const networks = Object.values(stats.networks || {});
  return {
    cpu:
      Number.isFinite(cpuDelta) && cpuDelta >= 0 && systemDelta > 0
        ? (cpuDelta / systemDelta) * cores * 100
        : null,
    memory: used,
    limit,
    percent: used !== null && limit ? (used / limit) * 100 : null,
    received: networks.length ? networks.reduce((sum, n) => sum + (n.rx_bytes || 0), 0) : null,
    sent: networks.length ? networks.reduce((sum, n) => sum + (n.tx_bytes || 0), 0) : null,
    pids: stats.pids_stats?.current ?? null,
  };
}

function ContainerDetail() {
  useLocale();
  const navigate = useNavigate();
  const { id } = useParams(),
    { job, busy } = useActions();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(
      ['logs', 'resources'].includes(searchParams.get('tab')) ? 'logs' : 'general',
    ),
    [logSearch, setLogSearch] = useState(''),
    [autoScroll, setAutoScroll] = useState(true),
    [editing, setEditing] = useState(false);
  const logEndRef = useRef(null),
    logPreRef = useRef(null);
  const detail = useData('inspect:' + id, `/containers/${id}/inspect`);
  const logs = useData('logs:' + id, `/containers/${id}/logs`, {
    enabled: tab === 'logs',
    refetchInterval: 5000,
  });
  const stats = useData('stats:' + id, `/containers/${id}/stats`, {
    enabled: tab === 'logs',
    refetchInterval: 5000,
  });
  // 로그를 보는 동안 최근 5분 사용량을 모아 작은 차트로 보여 준다. 네트워크는 누적값의 차이로 초당 전송량을 계산한다.
  const [history, setHistory] = useState([]);
  useEffect(() => setHistory([]), [id]);
  const inspect = Array.isArray(detail.data) ? detail.data[0] : detail.data;
  usePageTitle(inspect?.Name?.replace(/^\//, '') || id.slice(0, 12));
  const usage = stats.data && stats.data.text === undefined ? resourceUsage(stats.data) : null;
  useEffect(() => {
    if (!usage) return;
    const timestamp = stats.dataUpdatedAt;
    setHistory((previous) => {
      if (previous.at(-1)?.timestamp === timestamp) return previous;
      const last = previous.at(-1);
      const total = (usage.received ?? 0) + (usage.sent ?? 0);
      const seconds = last ? (timestamp - last.timestamp) / 1000 : 0;
      const network =
        last && seconds > 0 && usage.received !== null && total >= last.total
          ? (total - last.total) / seconds
          : null;
      return [
        ...previous.filter((point) => point.timestamp >= timestamp - 300000),
        { timestamp, cpu: usage.cpu, memory: usage.memory, network, total },
      ];
    });
  }, [stats.dataUpdatedAt]);

  const rawLog = logs.data?.text || '';
  const filteredLog = useMemo(() => {
    if (!logSearch.trim()) return rawLog;
    const q = logSearch.toLowerCase();
    return rawLog
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [rawLog, logSearch]);

  useEffect(() => {
    if (autoScroll && tab === 'logs') {
      if (logPreRef.current) {
        logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
      } else {
        logEndRef.current?.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [logs.data?.text, autoScroll, tab]);

  return (
    <section className={cn(tw.page, 'h-full')}>
      <PageActions>
        <PageAction
          label={t('설정 변경')}
          icon={Settings2}
          disabled={busy || detail.isLoading || !!detail.error || !inspect}
          onClick={() => setEditing(true)}
        />
        <PageAction
          label={t('상세 정보 다운로드 (JSON)')}
          icon={Download}
          disabled={detail.isLoading || !!detail.error || !inspect}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(detail.data, null, 2)], {
                type: 'application/json;charset=utf-8',
              }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = `${(inspect.Name?.replace(/^\//, '') || id).replace(/[^a-zA-Z0-9_.-]/g, '_')}-inspect.json`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        />
        <PageAction
          label={t('재시작')}
          icon={RotateCw}
          disabled={busy}
          onClick={() => job('containerAction', { id, action: 'restart' })}
        />
        <PageAction
          label={inspect?.State?.Paused ? t('계속 실행') : t('일시 정지')}
          icon={Pause}
          disabled={busy || !inspect?.State?.Running}
          onClick={() =>
            job('containerAction', { id, action: inspect?.State?.Paused ? 'unpause' : 'pause' })
          }
        />
      </PageActions>

      {inspect && (
        <EditContainerModal
          inspect={inspect}
          isOpen={editing}
          busy={busy}
          onClose={() => setEditing(false)}
          onSubmit={async (payload) => {
            const result = await job('updateContainer', { id, ...payload });
            if (result) navigate('/containers');
            return result;
          }}
        />
      )}

      <div className={cn(tw.panel, 'flex min-h-0 flex-1 flex-col')}>
        <div className={tw.tabs}>
          {[
            ['general', t('일반')],
            ['logs', t('로그와 리소스')],
            ['files', t('파일')],
            ['terminal', t('터미널')],
          ].map(([key, label]) => (
            <button
              aria-pressed={key === tab}
              className={cn(tw.tab, key === tab && tw.tabSelected)}
              key={key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'logs' ? (
          <div className="flex min-h-0 flex-1 max-desktop:flex-col">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {logs.isLoading ? (
                <Skeleton />
              ) : logs.error ? (
                <ErrorState error={logs.error} retry={() => logs.refetch()} />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex flex-none flex-wrap items-center justify-between gap-2.5 border-b border-line bg-[#fbfcf9] px-4 py-2.5 max-tablet:px-3 max-tablet:py-2">
                    <div className="flex h-8.5 w-full max-w-[280px] items-center gap-2 rounded-[6px] border border-[#e3e8df] bg-white px-2.5 text-[#8c978e]">
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
                    <div className="flex items-center gap-2">
                      <IconButton
                        icon={ArrowDown}
                        label={t('자동 스크롤')}
                        className={cn(
                          'border border-[#dce2d9] bg-white',
                          autoScroll && 'border-[#bdcdbb] bg-[#eef5e9] text-[#407543]',
                        )}
                        onClick={() => setAutoScroll(!autoScroll)}
                      />
                      <CopyButton
                        text={filteredLog || rawLog}
                        label={t('로그 복사')}
                        className="h-8.5 w-8.5 border border-[#dce2d9] bg-white"
                      />
                    </div>
                  </div>
                  <pre
                    ref={logPreRef}
                    className={cn(
                      tw.terminal,
                      // 긴 로그 줄은 접지 않고 가로로 스크롤한다.
                      'min-h-0 max-h-none flex-1 overflow-auto rounded-none whitespace-pre wrap-normal',
                    )}
                    aria-label={t('컨테이너 로그')}
                  >
                    {filteredLog ||
                      (logSearch
                        ? t('일치하는 로그가 없습니다.')
                        : t('아직 출력된 로그가 없습니다.'))}
                    <span ref={logEndRef} />
                  </pre>
                </div>
              )}
            </div>
            <aside
              aria-label={t('리소스 사용량')}
              className="flex w-[320px] flex-none flex-col gap-3 overflow-y-auto border-l border-line bg-[#fbfcf9] p-4 max-desktop:max-h-[45%] max-desktop:w-full max-desktop:border-t max-desktop:border-l-0 max-tablet:p-3"
            >
              {stats.error ? (
                <ErrorState error={stats.error} retry={() => stats.refetch()} />
              ) : stats.data?.text !== undefined ? (
                <pre
                  className={cn(tw.terminal, 'min-h-[180px] flex-1 overflow-auto')}
                  aria-label={t('containerd 리소스 사용량')}
                >
                  {stats.data.text || t('리소스 사용량을 아직 수집하지 못했습니다.')}
                </pre>
              ) : (
                <>
                  {usage &&
                    ((usage.cpu !== null && usage.cpu > 80) ||
                      (usage.percent !== null && usage.percent > 85)) && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[#f5c6cb] bg-[#fdf2f2] p-3.5 text-[12px] text-[#721c24]">
                        <div className="flex items-center gap-2">
                          <TriangleAlert size={17} className="flex-none text-danger" />
                          <span>
                            {t(
                              '리소스 사용량이 높습니다 (CPU {0}%, 메모리 {1}%). 누수가 발생했을 수 있습니다.',
                              [
                                usage.cpu ? usage.cpu.toFixed(1) : '-',
                                usage.percent ? usage.percent.toFixed(1) : '-',
                              ],
                            )}
                          </span>
                        </div>
                        <Button
                          compact
                          disabled={busy}
                          onClick={() => job('containerAction', { id, action: 'restart' })}
                        >
                          {t('컨테이너 재시작')}
                        </Button>
                      </div>
                    )}
                  <ResourceChart
                    compact
                    title="CPU"
                    points={history}
                    field="cpu"
                    format={percent}
                  />
                  <ResourceChart
                    compact
                    title={t('메모리')}
                    points={history}
                    field="memory"
                    format={bytes}
                    color="#477b9b"
                  />
                  <ResourceChart
                    compact
                    title={t('네트워크')}
                    points={history}
                    field="network"
                    format={rate}
                    color="#b07a2e"
                  />
                  <p className="flex justify-between px-1 text-[12px] text-muted">
                    <span>{t('프로세스')}</span>
                    <strong className="font-semibold text-ink tabular-nums">
                      {usage?.pids ?? '-'}
                    </strong>
                  </p>
                </>
              )}
            </aside>
          </div>
        ) : null}

        {tab === 'files' && <ContainerFileExplorer containerId={id} />}

        {tab === 'terminal' && (
          <Suspense fallback={<Skeleton />}>
            <TerminalPanel key={id} containerId={id} />
          </Suspense>
        )}

        {tab === 'general' ? (
          detail.isLoading ? (
            <Skeleton />
          ) : detail.error ? (
            <ErrorState error={detail.error} retry={() => detail.refetch()} />
          ) : inspect ? (
            <ContainerGeneral inspect={inspect} />
          ) : null
        ) : null}
      </div>
    </section>
  );
}
export default ContainerDetail;
