import { t, useLocale, formatDate } from '../i18n.js';
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
import { useData, jobNames, stateNames, Badge, ResourceGrid } from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Jobs({ openJob }) {
  const locale = useLocale();
  const data = useData('jobs', '/jobs', { refetchInterval: 2000 });
  const cols = useMemo(
    () => [
      {
        field: 'type',
        headerName: t('작업'),
        minWidth: 250,
        flex: 1,
        valueFormatter: ({ value }) => t(jobNames[value]) || value,
        filterable: true,
        filterValueGetter: (r) => t(jobNames[r.type]) || r.type,
      },
      {
        field: 'state',
        headerName: t('상태'),
        width: 150,
        filterable: true,
        filterValueGetter: (r) => t(stateNames[r.state]) || r.state,
        cellRenderer: ({ value }) => (
          <Badge state={value} tone={value === 'running' ? 'wait' : undefined}>
            {t(stateNames[value])}
          </Badge>
        ),
      },
      {
        field: 'createdAt',
        headerName: t('시작'),
        minWidth: 200,
        flex: 1,
        valueFormatter: ({ value }) => formatDate(value),
      },
      { field: 'error', headerName: t('결과'), minWidth: 250, flex: 1.2 },
    ],
    [locale],
  );
  return (
    <section className={tw.page}>
      <div className={tw.gridPanel}>
        <ResourceGrid query={data} columns={cols} onRowClicked={({ data: r }) => openJob(r.id)} />
      </div>
    </section>
  );
}
export default Jobs;
