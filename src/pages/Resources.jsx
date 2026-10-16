import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Layers,
  HardDrive,
  Network,
  Settings2,
  Activity,
  Camera,
  Play,
  Square,
  RotateCw,
  Trash2,
  Download,
  Plus,
  Search,
  ChevronRight,
  Terminal,
  FileCode,
  Menu,
  X,
  Copy,
  ArrowUpRight,
  Pause,
  RefreshCw,
  CircleHelp,
  Check,
  LoaderCircle,
  Container,
  ShipWheel,
  Tag,
} from 'lucide-react';
import {
  useActions,
  Button,
  IconButton,
  Skeleton,
  RuntimeEmpty,
  useResource,
  ResourceGrid,
  Toolbar,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Resources({ kind }) {
  const { status, job, form, confirm, busy, notify } = useActions(),
    data = useResource(kind);
  const [search, setSearch] = useState(''),
    [inspect, setInspect] = useState(null);
  const volume = kind === 'volumes',
    label = volume ? '볼륨' : '네트워크';
  const cols = useMemo(
    () => [
      {
        field: 'Name',
        headerName: '이름',
        minWidth: 230,
        flex: 1.4,
        cellRenderer: ({ value }) => <strong>{value}</strong>,
      },
      { field: 'Driver', headerName: '드라이버', minWidth: 140, flex: 0.6, filterable: !volume },
      {
        field: volume ? 'Mountpoint' : 'Scope',
        headerName: volume ? '마운트 경로' : '범위',
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
            label={`${label} 삭제`}
            danger
            disabled={busy}
            onClick={() =>
              confirm(
                `${label} 삭제`,
                `${r.Name}${volume ? '에 저장된 데이터도 함께 삭제됩니다.' : ' 네트워크를 삭제합니다.'}`,
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
    [volume, label, busy, confirm, job],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label={`${label} 생성`}
          primary
          icon={Plus}
          disabled={busy}
          onClick={() =>
            form(`${label} 생성`, [{ key: 'name', label: '이름', required: true }], (v) =>
              job(volume ? 'createVolume' : 'createNetwork', v),
            )
          }
        />
      </PageActions>
      <div className={tw.gridPanel}>
        <Toolbar search={search} onSearch={setSearch} />
        <ResourceGrid
          query={data}
          columns={cols}
          filter={search}
          onRowClicked={async ({ data: r, event }) => {
            if (event.target.closest('button')) return;
            try {
              setInspect(
                await api(`/${kind}/${encodeURIComponent(volume ? r.Name : r.Id)}/inspect`),
              );
            } catch (e) {
              notify(e);
            }
          }}
        />
      </div>
      <Modal
        isOpen={!!inspect}
        onClose={() => setInspect(null)}
        title={`${label} 구성`}
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
