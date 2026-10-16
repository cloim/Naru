import { t, useLocale } from '../i18n.js';
import React, {
  createContext,
  useContext,
  useMemo,
  useState,
} from 'react';
import {
  Boxes,
  ChevronRight,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  useActions,
  IconButton,
  Badge,
  Skeleton,
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

  const volume = kind === 'volumes',
    label = volume ? t('볼륨') : t('네트워크');

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
        width: 90,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <IconButton
            icon={Trash2}
            label={t(volume ? '볼륨 삭제' : '네트워크 삭제')}
            danger
            disabled={busy}
            onClick={() =>
              confirm(
                t(volume ? '볼륨 삭제' : '네트워크 삭제'),
                t(
                  volume ? '{0}에 저장된 데이터도 함께 삭제됩니다.' : '{0} 네트워크를 삭제합니다.',
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
        ),
      },
    ],
    [locale, volume, label, busy, confirm, job],
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
                  setInspect(
                    await api(`/${kind}/${encodeURIComponent(r.Name)}/inspect`),
                  );
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
                setInspect(
                  await api(`/${kind}/${encodeURIComponent(r.Id)}/inspect`),
                );
              } catch (e) {
                notify(e);
              }
            }}
          />
        )}
      </div>
      <Modal
        isOpen={!!inspect}
        onClose={() => setInspect(null)}
        title={t('{0} 구성', [label])}
        size="lg"
        resizable
        storageKey="resource-inspect"
      >
        <pre className={tw.jsonView}>{JSON.stringify(inspect, null, 2)}</pre>
      </Modal>
    </section>
  );
}

export default Resources;
