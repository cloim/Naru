import { t, useLocale } from '../i18n.js';
import React, { lazy, Suspense, useState } from 'react';
import { useParams } from 'react-router-dom';
import { RotateCw, Pause, Terminal, RefreshCw } from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  Skeleton,
  ErrorState,
  bytes,
  PageActions,
  PageAction,
  usePageTitle,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api } from '../api.js';
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
    { job, notify, busy } = useActions();
  const [tab, setTab] = useState('logs'),
    [args, setArgs] = useState('["sh", "-c", "pwd"]'),
    [output, setOutput] = useState(''),
    [execBusy, setExecBusy] = useState(false);
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
  const execute = async () => {
    setExecBusy(true);
    try {
      const parsed = JSON.parse(args);
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((arg) => typeof arg !== 'string'))
        throw new Error(t('실행 인수를 문자열이 담긴 JSON 배열로 입력해 주세요.'));
      const result = await api(`/containers/${id}/exec`, {
        method: 'POST',
        body: { args: parsed },
      });
      setOutput(
        [result.text, result.stderr].filter(Boolean).join('\n') ||
          t('명령이 완료되었습니다. 출력이 없습니다.'),
      );
    } catch (e) {
      notify(e);
    } finally {
      setExecBusy(false);
    }
  };
  return (
    <section className={tw.page}>
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
      <div className={cn(tw.panel, 'flex-1')}>
        <div className={tw.tabs}>
          {[
            ['logs', t('로그')],
            ['resources', t('리소스')],
            ['terminal', t('터미널')],
            ['exec', t('명령 실행')],
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
            <pre
              className={cn(tw.terminal, 'min-h-[400px] rounded-none')}
              aria-label={t('컨테이너 로그')}
            >
              {logs.data?.text || t('아직 출력된 로그가 없습니다.')}
            </pre>
          )
        ) : null}
        {tab === 'resources' ? (
          stats.isLoading ? (
            <Skeleton />
          ) : stats.error ? (
            <ErrorState error={stats.error} retry={() => stats.refetch()} />
          ) : stats.data?.text !== undefined ? (
            <pre
              className={cn(tw.terminal, 'min-h-[400px] rounded-none')}
              aria-label={t('containerd 리소스 사용량')}
            >
              {stats.data.text || t('리소스 사용량을 아직 수집하지 못했습니다.')}
            </pre>
          ) : usage ? (
            <div className="p-6 max-tablet:p-5">
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
        {tab === 'inspect' ? (
          detail.isLoading ? (
            <Skeleton />
          ) : detail.error ? (
            <ErrorState error={detail.error} retry={() => detail.refetch()} />
          ) : (
            <pre className={tw.jsonView}>{JSON.stringify(detail.data, null, 2)}</pre>
          )
        ) : null}
        {tab === 'terminal' && (
          <Suspense fallback={<Skeleton />}>
            <TerminalPanel key={id} containerId={id} />
          </Suspense>
        )}
        {tab === 'exec' && (
          <form
            className="p-5"
            onSubmit={(e) => {
              e.preventDefault();
              execute();
            }}
          >
            <label className={tw.field}>
              <span>{t('실행 인수 (JSON 배열)')}</span>
              <input value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <Button type="submit" icon={Terminal} disabled={execBusy || busy}>
              {execBusy ? t('실행 중') : t('실행')}
            </Button>
            <pre className={cn(tw.terminal, 'mt-5')} aria-label={t('명령 실행 결과')}>
              {output || t('명령 결과가 여기에 표시됩니다.')}
            </pre>
          </form>
        )}
      </div>
    </section>
  );
}
export default ContainerDetail;
