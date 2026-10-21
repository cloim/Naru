import { t, useLocale } from '../i18n.js';
import React, { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { RotateCw, Pause, Search, X, ArrowDown, TriangleAlert } from 'lucide-react';
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
const TerminalPanel = lazy(() => import('../components/TerminalPanel.jsx'));

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
  const { id } = useParams(),
    { job, busy } = useActions();
  const [tab, setTab] = useState('logs'),
    [logSearch, setLogSearch] = useState(''),
    [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef(null),
    logPreRef = useRef(null);
  const detail = useData('inspect:' + id, `/containers/${id}/inspect`);
  const logs = useData('logs:' + id, `/containers/${id}/logs`, {
    enabled: tab === 'logs',
    refetchInterval: 5000,
  });
  const stats = useData('stats:' + id, `/containers/${id}/stats`, {
    enabled: tab === 'resources',
    refetchInterval: 5000,
  });
  const inspect = Array.isArray(detail.data) ? detail.data[0] : detail.data;
  usePageTitle(inspect?.Name?.replace(/^\//, '') || id.slice(0, 12));
  const usage = stats.data ? resourceUsage(stats.data) : null;

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

      <div className={cn(tw.panel, 'flex min-h-0 flex-1 flex-col')}>
        {/* 탭 순서: 로그, 리소스, 파일, 터미널, 구성 */}
        <div className={tw.tabs}>
          {[
            ['logs', t('로그')],
            ['resources', t('리소스')],
            ['files', t('파일')],
            ['terminal', t('터미널')],
            ['inspect', t('구성')],
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
          logs.isLoading ? (
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
                  'min-h-0 flex-1 max-h-none overflow-auto rounded-none',
                )}
                aria-label={t('컨테이너 로그')}
              >
                {filteredLog ||
                  (logSearch ? t('일치하는 로그가 없습니다.') : t('아직 출력된 로그가 없습니다.'))}
                <span ref={logEndRef} />
              </pre>
            </div>
          )
        ) : null}

        {tab === 'resources' ? (
          stats.isLoading ? (
            <Skeleton />
          ) : stats.error ? (
            <ErrorState error={stats.error} retry={() => stats.refetch()} />
          ) : stats.data?.text !== undefined ? (
            <pre
              className={cn(tw.terminal, 'min-h-0 flex-1 rounded-none overflow-auto')}
              aria-label={t('containerd 리소스 사용량')}
            >
              {stats.data.text || t('리소스 사용량을 아직 수집하지 못했습니다.')}
            </pre>
          ) : usage ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6 max-tablet:p-5">
              {((usage.cpu !== null && usage.cpu > 80) ||
                (usage.percent !== null && usage.percent > 85)) && (
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[#f5c6cb] bg-[#fdf2f2] p-3.5 text-[12px] text-[#721c24]">
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
              <dl className="grid grid-cols-2 gap-6 max-tablet:grid-cols-1 [&_dd]:my-3 [&_dd]:text-[23px] [&_dd]:tracking-[-0.5px] [&_dd]:tabular-nums [&_dd]:wrap-anywhere [&_dt]:text-[12px] [&_dt]:text-muted [&_progress]:mt-3 [&_progress]:block [&_progress]:h-1.5 [&_progress]:w-full [&_progress]:accent-accent [&_small]:block [&_small]:leading-[1.6] [&>div]:min-w-0 [&>div]:border-b [&>div]:border-line [&>div]:pb-5">
                <div>
                  <dt>CPU</dt>
                  <dd>{usage.cpu === null ? t('수집 중') : `${usage.cpu.toFixed(2)}%`}</dd>
                  <small>{t('코어 1개 전체 사용량 = 100%')}</small>
                </div>
                <div>
                  <dt>{t('메모리')}</dt>
                  <dd>{usage.memory === null ? t('수집 중') : bytes(usage.memory)}</dd>
                  <small>
                    {usage.limit
                      ? t('한도 {0}{1}', [
                          bytes(usage.limit),
                          usage.percent === null ? '' : ` | ${usage.percent.toFixed(1)}%`,
                        ])
                      : t('한도 정보 수집 중')}
                  </small>
                  {usage.percent !== null && (
                    <progress
                      aria-label={t('메모리 한도 대비 사용률')}
                      max="100"
                      value={Math.min(100, usage.percent)}
                    />
                  )}
                </div>
                <div>
                  <dt>{t('네트워크 수신 / 송신')}</dt>
                  <dd>
                    {usage.received === null
                      ? t('수집 중')
                      : `${bytes(usage.received)} / ${bytes(usage.sent)}`}
                  </dd>
                  <small>{t('컨테이너 시작 이후 누적')}</small>
                </div>
                <div>
                  <dt>{t('프로세스')}</dt>
                  <dd>{usage.pids ?? t('수집 중')}</dd>
                </div>
              </dl>
            </div>
          ) : null
        ) : null}

        {tab === 'files' && <ContainerFileExplorer containerId={id} />}

        {tab === 'terminal' && (
          <Suspense fallback={<Skeleton />}>
            <TerminalPanel key={id} containerId={id} />
          </Suspense>
        )}

        {tab === 'inspect' ? (
          detail.isLoading ? (
            <Skeleton />
          ) : detail.error ? (
            <ErrorState error={detail.error} retry={() => detail.refetch()} />
          ) : (
            <pre className="m-0 min-h-0 flex-1 overflow-auto bg-[#fafcf7] p-5.5 font-mono text-[12px] leading-[1.8] whitespace-pre-wrap wrap-anywhere">
              {JSON.stringify(detail.data, null, 2)}
            </pre>
          )
        ) : null}
      </div>
    </section>
  );
}
export default ContainerDetail;
