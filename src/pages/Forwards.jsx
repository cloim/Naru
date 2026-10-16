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
import { useActions, useData, Button, IconButton, Badge, ResourceGrid } from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Forwards() {
  const data = useData('forwards', '/forwards', { refetchInterval: 5000 }),
    { job, form, busy, status } = useActions();
  const columns = useMemo(
    () => [
      { field: 'resource', headerName: '리소스', minWidth: 230, flex: 1.2, filterable: true },
      {
        field: 'namespace',
        headerName: '네임스페이스',
        minWidth: 160,
        flex: 0.7,
        filterable: true,
      },
      {
        headerName: '로컬 주소',
        minWidth: 200,
        flex: 1,
        valueGetter: ({ data: r }) => `127.0.0.1:${r.localPort} → ${r.remotePort}`,
      },
      {
        field: 'state',
        headerName: '상태',
        width: 130,
        cellRenderer: ({ value }) => <Badge state={value} />,
      },
      {
        headerName: '',
        width: 90,
        sortable: false,
        cellRenderer: ({ data: r }) =>
          r.state === 'running' && (
            <IconButton
              icon={Square}
              label="전달 종료"
              disabled={busy}
              onClick={() => job('stopForward', { id: r.id })}
            />
          ),
      },
    ],
    [busy, job],
  );
  return (
    <section className={tw.page}>
      <div className={tw.pageIntro}>
        <div>
          <h2>로컬에서 바로 연결</h2>
          <p>Kubernetes 서비스를 Windows의 localhost로 연결하세요.</p>
        </div>
        <Button
          primary
          icon={Plus}
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              '포트 전달',
              [
                {
                  key: 'resource',
                  label: '대상 리소스',
                  required: true,
                  placeholder: 'svc/my-web',
                  hint: 'svc/이름, pod/이름, deployment/이름',
                },
                { key: 'namespace', label: '네임스페이스', value: 'default' },
                {
                  key: 'localPort',
                  label: 'Windows 로컬 포트',
                  type: 'number',
                  required: true,
                  value: '8080',
                },
                {
                  key: 'remotePort',
                  label: '대상 포트',
                  type: 'number',
                  required: true,
                  value: '80',
                },
              ],
              (v) =>
                job('createForward', {
                  ...v,
                  localPort: Number(v.localPort),
                  remotePort: Number(v.remotePort),
                }),
            )
          }
        >
          포트 연결
        </Button>
      </div>
      <div className={tw.panel}>
        <ResourceGrid query={data} columns={columns} />
      </div>
    </section>
  );
}
export default Forwards;
