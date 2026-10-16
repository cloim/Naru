import { t, useLocale, formatDate } from '../i18n.js';
import React, { useMemo, useState } from 'react';
import { Play, Square, Trash2, Download, Plus, Terminal, RefreshCw } from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  IconButton,
  Skeleton,
  ErrorState,
  Empty,
  RuntimeEmpty,
  ResourceGrid,
  Toolbar,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';

export function kubernetesState(kind, r) {
  const status = r.status || {};
  if (kind === 'pods') {
    if (r.metadata.deletionTimestamp) return t('종료 중');
    const containers = status.containerStatuses || [];
    const reason = [...(status.initContainerStatuses || []), ...containers]
      .map((c) => c.state?.waiting?.reason || c.state?.terminated?.reason)
      .find((reason) => reason && reason !== 'Completed');
    return t('{0} | {1}/{2} 준비됨', [
      reason || status.reason || status.phase || t('대기 중'),
      containers.filter((c) => c.ready).length,
      r.spec?.containers?.length || 0,
    ]);
  }
  if (kind === 'deployments')
    return t('{0}/{1} 준비됨 | {2} 사용 가능', [
      status.readyReplicas || 0,
      r.spec?.replicas ?? 1,
      status.availableReplicas || 0,
    ]);
  if (kind === 'nodes') {
    const ready = status.conditions?.find((c) => c.type === 'Ready');
    const pressure = (status.conditions || [])
      .filter((c) => c.type !== 'Ready' && c.status === 'True')
      .map((c) => c.type);
    return [
      ready?.status === 'True'
        ? t('준비됨')
        : ready?.status === 'False'
          ? t('준비 안 됨')
          : t('상태 미확인'),
      r.spec?.unschedulable ? t('스케줄링 중지') : null,
      ...pressure,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  if (kind === 'services') return r.spec?.type || 'ClusterIP';
  if (kind === 'events') return [r.type, r.reason].filter(Boolean).join(' | ');
  return status.phase || t('상태 없음');
}

function Kubernetes() {
  const locale = useLocale();
  const { status, job, form, confirm, view, notify, busy } = useActions();
  const [kind, setKind] = useState('pods'),
    [search, setSearch] = useState(''),
    [namespace, setNamespace] = useState(''),
    [logPod, setLogPod] = useState(null);
  const managed = !!status?.ready && status.managed;
  const state = useData('kube:state', '/kubernetes/state', {
    enabled: managed,
    refetchInterval: 5000,
  });
  const running = !!state.data?.running;
  const data = useData('kube:' + kind, '/kubernetes?kind=' + kind, {
    enabled: managed && running,
    refetchInterval: 10000,
  });
  const logs = useData(
    'pod-logs:' + logPod?.metadata.namespace + ':' + logPod?.metadata.name,
    `/kubernetes/logs?${new URLSearchParams({ namespace: logPod?.metadata.namespace || 'default', name: logPod?.metadata.name || '' })}`,
    { enabled: !!logPod, refetchInterval: logPod ? 5000 : false },
  );
  const namespaces = useMemo(
    () =>
      [
        ...new Set((data.data?.items || []).map((r) => r.metadata.namespace).filter(Boolean)),
      ].sort(),
    [data.data],
  );
  const rows = useMemo(
    () => (data.data?.items || []).filter((r) => !namespace || r.metadata.namespace === namespace),
    [data.data, namespace],
  );
  const cols = useMemo(
    () => [
      {
        headerName: t('이름'),
        colId: 'name',
        minWidth: 230,
        flex: 1.3,
        valueGetter: ({ data: r }) => r.metadata.name,
      },
      {
        headerName: t('네임스페이스'),
        colId: 'namespace',
        minWidth: 160,
        flex: 0.8,
        valueGetter: ({ data: r }) => r.metadata.namespace || t('클러스터'),
      },
      {
        headerName: t('상태'),
        colId: 'status',
        minWidth: 220,
        flex: 1,
        filterable: true,
        valueGetter: ({ data: r }) => kubernetesState(kind, r),
      },
      {
        headerName: t('생성'),
        width: 170,
        valueGetter: ({ data: r }) =>
          r.metadata.creationTimestamp ? formatDate(r.metadata.creationTimestamp) : t('정보 없음'),
      },
      {
        headerName: '',
        colId: 'actions',
        width: kind === 'pods' ? 110 : 70,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <div className={tw.rowActions} onClick={(e) => e.stopPropagation()}>
            {kind === 'pods' && (
              <IconButton
                icon={Terminal}
                label={t('{0} 로그 보기', [r.metadata.name])}
                onClick={() => setLogPod(r)}
              />
            )}{' '}
            {!['nodes', 'events'].includes(kind) && (
              <IconButton
                icon={Trash2}
                danger="row"
                label={t('{0} 삭제', [r.metadata.name])}
                disabled={busy}
                onClick={() =>
                  confirm(
                    t('Kubernetes 리소스 삭제'),
                    t('{0}{1} 리소스를 삭제합니다.', [
                      r.metadata.namespace ? r.metadata.namespace + ' / ' : '',
                      r.metadata.name,
                    ]),
                    () =>
                      job('kubeDelete', {
                        kind,
                        name: r.metadata.name,
                        namespace: r.metadata.namespace || 'default',
                      }),
                  )
                }
              />
            )}
          </div>
        ),
      },
    ],
    [locale, kind, busy, confirm, job],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  if (!status.managed)
    return (
      <Empty title={t('Kubernetes는 External Engine에서 관리합니다')}>
        {' '}
        {t('공유 모드에서는 External Engine 화면에서 Kubernetes를 사용해 주세요.')}{' '}
      </Empty>
    );
  return (
    <section className={tw.page}>
      {running && (
        <PageActions>
          <PageAction
            label={t('Kubernetes 종료')}
            icon={Square}
            disabled={busy}
            onClick={() =>
              confirm(t('Kubernetes 종료'), t('컨테이너 엔진은 계속 실행됩니다.'), () =>
                job('stopKubernetes'),
              )
            }
          />
          <PageAction
            label={t('kubeconfig 내려받기')}
            icon={Download}
            onClick={() => downloadConfig().catch(notify)}
          />
          <PageAction
            label={t('YAML 적용')}
            primary
            icon={Plus}
            disabled={busy}
            onClick={() =>
              form(
                t('리소스 적용'),
                [
                  {
                    key: 'yaml',
                    label: 'Kubernetes YAML',
                    type: 'textarea',
                    rows: 14,
                    required: true,
                    placeholder:
                      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\ndata:\n  key: value',
                  },
                ],
                (v) => job('kubeApply', v),
              )
            }
          />
        </PageActions>
      )}
      {state.isLoading ? (
        <Skeleton />
      ) : state.error ? (
        <ErrorState error={state.error} retry={() => state.refetch()} />
      ) : !running ? (
        <div className={cn(tw.panel, 'flex flex-1 items-center justify-center')}>
          <Empty
            title={t('Kubernetes가 꺼져 있습니다')}
            action={
              <Button primary icon={Play} disabled={busy} onClick={() => job('startKubernetes')}>
                {' '}
                {t('Kubernetes 시작')}{' '}
              </Button>
            }
          >
            {' '}
            {t(
              '컨테이너 엔진과 별도로 k3s를 시작합니다. 엔진 시작 때 함께 시작하려면 설정에서 지정해 주세요.',
            )}{' '}
          </Empty>
        </div>
      ) : (
        <div className={tw.gridPanel}>
          <div className={cn(tw.actions, 'px-5.5 pt-5')}>
            <SelectControl
              aria-label={t('리소스 종류')}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setNamespace('');
              }}
            >
              {[
                ['pods', t('파드')],
                ['deployments', t('디플로이먼트')],
                ['services', t('서비스')],
                ['nodes', t('노드')],
                ['namespaces', t('네임스페이스')],
                ['configmaps', 'ConfigMap'],
                ['persistentvolumeclaims', t('볼륨 클레임')],
                ['events', t('이벤트')],
              ].map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SelectControl>
            {namespaces.length > 0 && (
              <SelectControl
                aria-label={t('네임스페이스 필터')}
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
              >
                <option value="">{t('모든 네임스페이스')}</option>
                {namespaces.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </SelectControl>
            )}
          </div>
          <Toolbar search={search} onSearch={setSearch} />
          <ResourceGrid
            query={{ ...data, data: rows }}
            columns={cols}
            filter={search}
            onRowClicked={({ data: r, event }) => {
              if (event.target.closest('button')) return;
              view(t('{0} 구성', [r.metadata.name]), r);
            }}
          />
        </div>
      )}
      <Modal
        isOpen={!!logPod}
        title={t('{0} / {1} 로그', [
          logPod?.metadata.namespace || 'default',
          logPod?.metadata.name || '',
        ])}
        onClose={() => setLogPod(null)}
        size="lg"
        footer={
          <>
            <Button icon={RefreshCw} disabled={logs.isFetching} onClick={() => logs.refetch()}>
              {' '}
              {t('새로고침')}{' '}
            </Button>
            <Button onClick={() => setLogPod(null)}>{t('닫기')}</Button>
          </>
        }
      >
        {logs.isLoading ? (
          <Skeleton />
        ) : logs.error ? (
          <ErrorState error={logs.error} retry={() => logs.refetch()} />
        ) : (
          <pre className={tw.terminal} aria-label={t('파드 로그')}>
            {logs.data?.text || t('아직 출력된 로그가 없습니다.')}
          </pre>
        )}
      </Modal>
    </section>
  );
}
export default Kubernetes;
