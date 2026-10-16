import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Play, Square, Trash2, Plus, Terminal, RefreshCw } from 'lucide-react';
import {
  useActions,
  Button,
  IconButton,
  Badge,
  Skeleton,
  containerName,
  RuntimeEmpty,
  useResource,
  ResourceGrid,
  Toolbar,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
export const isSystemContainer = (r) =>
  Boolean(
    r.Labels?.['io.kubernetes.pod.name'] ||
    r.Labels?.['io.kubernetes.container.name'] ||
    (r.Names || []).some((name) => /^\/?k8s_/.test(name)),
  );
function Containers() {
  const { status, job, form, confirm, busy } = useActions(),
    data = useResource('containers'),
    navigate = useNavigate();
  const [search, setSearch] = useState(''),
    [tab, setTab] = useState('all'),
    [showSystem, setShowSystem] = useState(false);
  const visible = useMemo(
    () =>
      (data.data || [])
        .filter((r) => showSystem || !isSystemContainer(r))
        .filter((r) => JSON.stringify(r).toLowerCase().includes(search.toLowerCase())),
    [data.data, showSystem, search],
  );
  const cols = useMemo(
    () => [
      {
        headerName: '컨테이너',
        colId: 'name',
        minWidth: 210,
        flex: 1.3,
        valueGetter: ({ data: r }) => containerName(r),
        cellRenderer: ({ data: r }) => (
          <div className={tw.nameCell}>
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
        headerName: '상태',
        width: 125,
        cellRenderer: ({ value }) => <Badge state={value} />,
      },
      { field: 'Image', headerName: '이미지', minWidth: 190, flex: 1.2, filterable: true },
      {
        headerName: '포트',
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
              label={r.State === 'running' ? '중지' : '시작'}
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
              label="로그 보기"
              onClick={() => navigate('/containers/' + r.Id)}
            />
            <IconButton
              icon={Trash2}
              label="삭제"
              danger="row"
              disabled={busy}
              onClick={() =>
                confirm(
                  '컨테이너 삭제',
                  `${containerName(r)} 컨테이너를 삭제합니다. 연결된 볼륨은 보존됩니다.`,
                  () => job('containerAction', { id: r.Id, action: 'remove' }),
                )
              }
            />
          </div>
        ),
      },
    ],
    [busy, job, confirm, navigate],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  const filtered = {
    ...data,
    data: visible.filter(
      (r) => tab === 'all' || (tab === 'running' ? r.State === 'running' : r.State !== 'running'),
    ),
  };
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label="컨테이너 실행"
          icon={Plus}
          primary
          disabled={busy}
          onClick={() =>
            form(
              '컨테이너 실행',
              [
                { key: 'image', label: '이미지', required: true, placeholder: 'nginx:alpine' },
                { key: 'name', label: '이름', placeholder: 'my-web' },
                {
                  key: 'ports',
                  label: '포트',
                  placeholder: '8080:80, 8443:443',
                  hint: '호스트 포트:컨테이너 포트. Windows의 127.0.0.1에 공개합니다.',
                },
                {
                  key: 'env',
                  label: '환경 변수',
                  type: 'textarea',
                  rows: 3,
                  placeholder: 'APP_ENV=development\nLOG_LEVEL=info',
                },
                {
                  key: 'mounts',
                  label: '볼륨과 마운트 (JSON)',
                  type: 'textarea',
                  rows: 3,
                  value: '[]',
                  hint: '예: [{"source":"my-data","target":"/data","readOnly":false}]',
                },
                { key: 'command', label: '실행 인수 (JSON)', value: '[]' },
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
            ['all', '전체'],
            ['running', '실행 중'],
            ['stopped', '종료됨'],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              className={cn(tw.tab, tab === key && tw.tabSelected)}
              onClick={() => setTab(key)}
            >
              {label}
              <span>
                {
                  visible.filter(
                    (r) =>
                      key === 'all' ||
                      (key === 'running' ? r.State === 'running' : r.State !== 'running'),
                  ).length
                }
              </span>
            </button>
          ))}
        </div>
        <Toolbar search={search} onSearch={setSearch} wrap>
          <label className={cn(tw.checkbox, 'whitespace-nowrap')}>
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
            />
            시스템 컨테이너 표시
          </label>
          <IconButton icon={RefreshCw} label="새로고침" onClick={() => data.refetch()} />
        </Toolbar>
        <ResourceGrid
          query={filtered}
          columns={cols}
          onRowClicked={({ data: r, event }) => {
            if (!event.target.closest('button')) navigate('/containers/' + r.Id);
          }}
        />
      </div>
    </section>
  );
}
export default Containers;
