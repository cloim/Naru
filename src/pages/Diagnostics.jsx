import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t, useLocale } from '../i18n.js';
import { useActions, useData, Skeleton, ErrorState, bytes } from '../ui.jsx';
import ResourceChart from '../components/ResourceChart.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
import { cn, tw } from '../tw.js';

const percent = (value) => `${value.toFixed(1)}%`;
const time = (value) => new Date(value).toLocaleTimeString();

function Diagnostics() {
  useLocale();
  const data = useData('diagnostics', '/diagnostics', { refetchInterval: 5000 });
  const resources = useData('diagnostic-resources', '/diagnostics/resources', {
    refetchInterval: 3000,
    retry: false,
  });
  const { status } = useActions();
  const [history, setHistory] = useState([]);
  const [scope, setScope] = useState('all');
  const [tab, setTab] = useState('graphs');
  const logRef = useRef(null);
  const follow = useRef(true);
  useEffect(() => {
    if (!resources.data) return;
    const sample = resources.data;
    setHistory((previous) =>
      [
        ...previous.filter(
          (point) =>
            point.timestamp !== sample.timestamp && point.timestamp >= sample.timestamp - 300000,
        ),
        sample,
      ].slice(-120),
    );
  }, [resources.data]);
  useEffect(() => {
    if (follow.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data.data, tab]);
  const points = useMemo(
    () =>
      history.map((sample) => {
        const containers = sample.containers;
        const selected = containers?.find((container) => container.id === scope);
        return {
          timestamp: sample.timestamp,
          cpu:
            scope === 'all'
              ? containers?.reduce((sum, container) => sum + container.cpu, 0)
              : selected?.cpu,
          memory:
            scope === 'all'
              ? containers?.reduce((sum, container) => sum + container.memory, 0)
              : selected?.memory,
          serverCpu: sample.server.cpu,
          serverMemory: sample.server.memory,
          hostCpu: sample.host.cpu,
          hostMemory: sample.host.memory,
        };
      }),
    [history, scope],
  );
  const tabs = [
    ['graphs', t('진단 그래프')],
    ['engine', t('엔진 로그')],
    ['kubernetes', t('Kubernetes 로그')],
    ['buildkit', t('빌드 엔진 로그')],
  ];
  return (
    <section className={tw.page}>
      <section className={cn(tw.panel, 'sticky top-0 z-20 shrink-0')}>
        <div className={tw.tabs} role="tablist" aria-label={t('진단')}>
          {tabs.map(([key, label], index) => (
            <button
              key={key}
              id={`log-tab-${key}`}
              role="tab"
              aria-selected={tab === key}
              aria-controls={`log-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              className={cn(tw.tab, tab === key && tw.tabSelected)}
              onClick={() => {
                follow.current = true;
                setTab(key);
              }}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  follow.current = true;
                  setTab(tabs[next][0]);
                  document.getElementById(`log-tab-${tabs[next][0]}`).focus();
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <div
        role="tabpanel"
        id={`log-panel-${tab}`}
        aria-labelledby={`log-tab-${tab}`}
        tabIndex={0}
        className="flex min-w-0 flex-col gap-4"
      >
        {tab === 'graphs' ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    resources.error ? 'bg-red-600' : 'bg-brand',
                  )}
                />
                <span>{t('3초마다 자동 갱신')}</span>
                {resources.data && (
                  <span>
                    {t('마지막 수집')}: {time(resources.data.timestamp)}
                  </span>
                )}
              </div>
              <SelectControl
                wrapperClassName="max-w-full"
                className="max-w-full"
                aria-label={t('리소스 대상')}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="all">{t('전체 컨테이너')}</option>
                {resources.data?.containers?.map((container) => (
                  <option key={container.id} value={container.id}>
                    {container.name}
                  </option>
                ))}
                {scope !== 'all' &&
                  !resources.data?.containers?.some((container) => container.id === scope) && (
                    <option value={scope}>{t('종료된 컨테이너')}</option>
                  )}
              </SelectControl>
            </div>
            {resources.error && (
              <ErrorState error={resources.error} retry={() => resources.refetch()} />
            )}
            {resources.data?.containerError && (
              <p
                role="status"
                className="rounded-lg border border-line bg-paper px-4 py-3 text-xs text-muted"
              >
                {t(resources.data.containerError)}
              </p>
            )}
            {resources.isLoading ? (
              <Skeleton />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 max-tablet:grid-cols-1">
                  <ResourceChart
                    title={t('컨테이너 CPU')}
                    points={points}
                    field="cpu"
                    format={percent}
                  />
                  <ResourceChart
                    title={t('컨테이너 메모리')}
                    points={points}
                    field="memory"
                    format={bytes}
                  />
                  <ResourceChart
                    title={t('Naru 제어 서버 CPU')}
                    points={points}
                    field="serverCpu"
                    format={percent}
                    color="#986629"
                  />
                  <ResourceChart
                    title={t('Naru 제어 서버 메모리')}
                    points={points}
                    field="serverMemory"
                    format={bytes}
                    color="#986629"
                  />
                  <ResourceChart
                    title={t('호스트 시스템 CPU')}
                    points={points}
                    field="hostCpu"
                    format={percent}
                    ceiling={100}
                    color="#477b9b"
                  />
                  <ResourceChart
                    title={t('호스트 시스템 메모리')}
                    points={points}
                    field="hostMemory"
                    format={bytes}
                    ceiling={resources.data?.host.limit}
                    color="#477b9b"
                  />
                </div>
                <p className="px-1 text-[11px] text-muted">
                  {t(
                    '컨테이너와 제어 서버 CPU는 코어 1개를 100%로 표시합니다. 호스트 CPU는 전체 코어 기준입니다.',
                  )}
                </p>
              </>
            )}
            {data.data && (
              <div className={cn(tw.panel, 'flex flex-wrap gap-x-8 gap-y-4 p-5 text-xs')}>
                {[
                  [t('WSL 배포판'), data.data.distributions.join(', ')],
                  ['Node', data.data.node],
                  [t('데이터 경로'), status?.dataPath],
                ].map(([label, value]) => (
                  <div key={label} className="flex min-w-0 flex-col gap-2">
                    <span className="text-muted">{label}</span>
                    <strong className="font-medium wrap-anywhere">{value || '−'}</strong>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <section className={tw.panel}>
            {data.isLoading ? (
              <Skeleton />
            ) : data.error ? (
              <ErrorState error={data.error} retry={() => data.refetch()} />
            ) : (
              <pre
                ref={logRef}
                onScroll={(event) => {
                  const el = event.currentTarget;
                  follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
                }}
                className={cn(
                  tw.terminal,
                  'h-[calc(100dvh-200px)] max-h-none min-h-[270px] rounded-none',
                )}
              >
                {data.data?.logs?.[tab] || t('아직 로그가 없습니다.')}
              </pre>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
export default Diagnostics;
