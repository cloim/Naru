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
import {
  useActions,
  useData,
  Button,
  IconButton,
  Skeleton,
  ErrorState,
  Empty,
  bytes,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Snapshots() {
  useLocale();
  const { job, form, confirm, busy, status } = useActions(),
    data = useData('snapshots', '/snapshots');
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label={t('스냅샷 생성')}
          icon={Camera}
          primary
          disabled={busy || !status?.installed}
          onClick={() =>
            form(
              t('스냅샷 생성'),
              [
                {
                  key: 'name',
                  label: t('이름'),
                  required: true,
                  placeholder: t('변경 전 개발 환경'),
                },
              ],
              (v) => job('snapshot', v),
              t(
                '현재 실행 중이면 백업 후 엔진을 다시 시작합니다. 데이터 크기에 따라 시간이 걸릴 수 있습니다.',
              ),
            )
          }
        />
      </PageActions>
      {data.isLoading ? (
        <Skeleton />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : data.data?.length ? (
        <div className={tw.cardList}>
          {data.data.map((s) => (
            <article className={cn(tw.panel, tw.card)} key={s.id}>
              <div className={tw.cardIcon}>
                <Camera size={24} />
              </div>
              <div>
                <h3>{s.name}</h3>
                <p>
                  {formatDate(s.createdAt)} | {bytes(s.bytes)}
                </p>
              </div>
              <div className={tw.cardActions}>
                <Button
                  icon={RotateCw}
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      t('스냅샷 복원'),
                      t(
                        '현재 데이터를 이 스냅샷으로 교체합니다. 교체 직전 백업도 별도 저장합니다.',
                      ),
                      (v) => job('restoreSnapshot', { id: s.id, confirmation: v.confirmation }),
                      'RESTORE',
                    )
                  }
                >
                  {' '}
                  {t('복원')}{' '}
                </Button>
                <IconButton
                  icon={Trash2}
                  label={t('스냅샷 삭제')}
                  danger
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      t('스냅샷 삭제'),
                      t('{0} 스냅샷 파일을 영구 삭제합니다.', [s.name]),
                      (v) => job('deleteSnapshot', { id: s.id, confirmation: v.confirmation }),
                      'DELETE',
                    )
                  }
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className={tw.panel}>
          <Empty title={t('아직 저장한 스냅샷이 없어요')}>
            {t('큰 변경 전에 현재 환경을 저장해 두세요.')}
          </Empty>
        </div>
      )}
    </section>
  );
}
export default Snapshots;
