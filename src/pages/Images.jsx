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
  Upload,
  Hammer,
  BrushCleaning,
} from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  IconButton,
  Skeleton,
  ErrorState,
  bytes,
  imageName,
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
import { PruneConfirmModal } from '../components/PruneConfirmModal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function ImageLayerModal({ image, onClose }) {
  useLocale();
  const history = useData(
    ['image-history', image.id],
    `/images/${encodeURIComponent(image.id)}/history`,
    { enabled: !!image.id },
  );

  const layers = useMemo(() => {
    const list = history.data || [];
    return list.map((l) => {
      let cmd = l.CreatedBy || '';
      cmd = cmd.replace(/^\/bin\/sh -c #(nop)\s+/, '');
      cmd = cmd.replace(/^\/bin\/sh -c\s+/, 'RUN ');
      cmd = cmd.replace(/\s+# buildkit$/, '');
      const sizeNum = typeof l.Size === 'number' ? l.Size : 0;
      return {
        ...l,
        cmd,
        sizeNum,
      };
    });
  }, [history.data]);

  const totalCalculated = useMemo(
    () => layers.reduce((acc, l) => acc + (l.sizeNum || 0), 0),
    [layers],
  );

  const maxSize = useMemo(
    () => Math.max(1, ...layers.map((l) => l.sizeNum || 0)),
    [layers],
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('{0} 레이어 용량 분석', [image.name])}
      size="xl"
      footer={<Button onClick={onClose}>{t('닫기')}</Button>}
    >
      {history.isLoading ? (
        <Skeleton />
      ) : history.error ? (
        <ErrorState error={history.error} retry={() => history.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[#dce4d6] bg-[#fbfcf9] p-4 text-[12px]">
            <div>
              <span className="font-semibold text-[#536454]">{t('총 레이어 수')}: </span>
              <strong className="text-ink">{layers.length}개</strong>
            </div>
            <div>
              <span className="font-semibold text-[#536454]">{t('이미지 크기')}: </span>
              <strong className="text-ink">{bytes(image.size || totalCalculated)}</strong>
            </div>
            <div>
              <span className="font-semibold text-[#536454]">{t('최대 단일 레이어')}: </span>
              <strong className="text-ink">{bytes(maxSize)}</strong>
            </div>
          </div>

          <div className="max-h-[500px] overflow-y-auto rounded-[8px] border border-line">
            <div className="flex flex-col divide-y divide-[#edf1ea]">
              {layers.map((l, idx) => {
                const ratio = Math.round(((l.sizeNum || 0) / maxSize) * 100);
                const isHeavy = l.sizeNum > 50 * 1024 * 1024;
                return (
                  <div key={idx} className="flex flex-col gap-1.5 p-3 hover:bg-[#fcfdfa]">
                    <div className="flex items-center justify-between gap-2 text-[12px]">
                      <div className="flex items-center gap-2 font-mono">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-[#edf3ec] text-[10px] font-semibold text-[#4d6650]">
                          {layers.length - idx}
                        </span>
                        <span
                          className={cn(
                            'text-[11px] font-semibold',
                            isHeavy ? 'text-[#b24639]' : 'text-ink',
                          )}
                        >
                          {bytes(l.sizeNum)}
                        </span>
                        {l.sizeNum > 0 && totalCalculated > 0 && (
                          <span className="text-[10px] text-muted">
                            ({((l.sizeNum / totalCalculated) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] text-[#9aa297]">
                        {l.Id ? l.Id.slice(0, 12) : '<missing>'}
                      </span>
                    </div>

                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#edf1ea]">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          isHeavy ? 'bg-[#b24639]' : 'bg-brand',
                        )}
                        style={{ width: `${Math.max(ratio, l.sizeNum > 0 ? 2 : 0)}%` }}
                      />
                    </div>

                    <pre className="mt-1 font-mono text-[11px] leading-relaxed text-[#405244] whitespace-pre-wrap wrap-anywhere">
                      {l.cmd || '(빈 명령)'}
                    </pre>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Images() {
  const locale = useLocale();
  const { status, job, form, confirm, busy } = useActions(),
    data = useResource('images');
  const [search, setSearch] = useState(''),
    [layerInspectImage, setLayerInspectImage] = useState(null),
    [pruneModalOpen, setPruneModalOpen] = useState(false);
  const sortedData = useMemo(() => {
    if (!data.data) return data.data;
    return [...data.data].sort((a, b) =>
      (imageName(a) || '').localeCompare(imageName(b) || '', locale),
    );
  }, [data.data, locale]);
  const cols = useMemo(
    () => [
      {
        headerName: t('이미지'),
        colId: 'image',
        minWidth: 270,
        flex: 1.6,
        sort: 'asc',
        valueGetter: ({ data: r }) => imageName(r),
        cellRenderer: ({ data: r }) => (
          <div className={tw.nameCell}>
            <Layers size={19} />
            <div>
              <strong>{imageName(r)}</strong>
              <small>{r.Id?.replace('sha256:', '').slice(0, 12)}</small>
            </div>
          </div>
        ),
      },
      {
        headerName: t('크기'),
        field: 'Size',
        width: 130,
        valueFormatter: ({ value }) => bytes(value),
      },
      {
        headerName: t('생성'),
        field: 'Created',
        minWidth: 160,
        valueFormatter: ({ value }) =>
          typeof value === 'number' ? formatDate(value * 1000) : value || '—',
      },
      {
        headerName: '',
        colId: 'actions',
        width: 290,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <div className={tw.rowActions}>
            <IconButton
              label={t('레이어 용량 분석')}
              icon={Layers}
              disabled={busy}
              onClick={() =>
                setLayerInspectImage({
                  id: r.Id,
                  name: imageName(r),
                  size: r.Size,
                })
              }
            />
            <IconButton
              label={t('실행')}
              icon={Play}
              disabled={busy}
              onClick={() =>
                form(
                  t('이미지 실행'),
                  [{ key: 'name', label: t('컨테이너 이름'), placeholder: 'my-container' }],
                  (v) =>
                    job('createContainer', {
                      image: imageName(r),
                      ...(v.name ? { name: v.name } : {}),
                    }),
                )
              }
            />
            <IconButton
              label={t('이미지 내보내기')}
              icon={Download}
              disabled={busy}
              onClick={() =>
                form(
                  t('이미지 내보내기'),
                  [
                    {
                      key: 'file',
                      label: t('Windows TAR 저장 경로'),
                      required: true,
                      placeholder: 'D:\\MySetting\\Downloads\\image.tar',
                    },
                  ],
                  (v) => job('exportImage', { image: imageName(r), file: v.file }),
                )
              }
            />
            <IconButton
              label={t('취약점 분석')}
              icon={Search}
              disabled={busy}
              onClick={() => job('scanImage', { image: imageName(r) })}
            />
            <IconButton
              label={t('태그 추가')}
              icon={Tag}
              disabled={busy}
              onClick={() =>
                form(
                  t('이미지 태그'),
                  [
                    {
                      key: 'target',
                      label: t('새 태그'),
                      required: true,
                      placeholder: 'my-app:latest',
                    },
                  ],
                  (v) => job('tagImage', { id: r.Id, target: v.target }),
                )
              }
            />
            <IconButton
              label={t('레지스트리로 보내기')}
              icon={ArrowUpRight}
              disabled={busy}
              onClick={() =>
                confirm(
                  t('이미지 보내기'),
                  t('{0} 이미지를 지정된 레지스트리에 보냅니다.', [imageName(r)]),
                  () => job('pushImage', { image: imageName(r) }),
                )
              }
            />
            <IconButton
              label={t('이미지 삭제')}
              icon={Trash2}
              danger="row"
              disabled={busy}
              onClick={() =>
                confirm(
                  t('이미지 삭제'),
                  t('{0} 이미지를 삭제합니다. 사용 중인 이미지는 엔진이 보호합니다.', [
                    imageName(r),
                  ]),
                  () => job('removeImage', { id: r.Id }),
                )
              }
            />
          </div>
        ),
      },
    ],
    [locale, busy, form, job, confirm],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  return (
    <section className={tw.page}>
      <PageActions>
        <PageAction
          label={t('미사용 이미지 정리')}
          icon={BrushCleaning}
          disabled={busy}
          onClick={() => setPruneModalOpen(true)}
        />
        <PageAction
          label={t('이미지 빌드')}
          icon={Hammer}
          disabled={busy}
          onClick={() =>
            form(
              t('이미지 빌드'),
              [
                {
                  key: 'context',
                  label: t('Windows 소스 폴더'),
                  required: true,
                  placeholder: 'D:\\PROJECTS\\my-app',
                },
                { key: 'tag', label: t('이미지 태그'), required: true, placeholder: 'my-app:dev' },
                { key: 'dockerfile', label: 'Dockerfile', value: 'Dockerfile' },
              ],
              (v) => job('buildImage', v),
            )
          }
        />
        <PageAction
          label={t('이미지 불러오기')}
          icon={Upload}
          disabled={busy}
          onClick={() =>
            form(
              t('이미지 불러오기'),
              [
                {
                  key: 'file',
                  label: t('Windows TAR 파일'),
                  required: true,
                  placeholder: 'D:\\MySetting\\Downloads\\image.tar',
                },
              ],
              (v) => job('importImage', v),
            )
          }
        />
        <PageAction
          label={t('이미지 가져오기')}
          icon={Download}
          primary
          disabled={busy}
          onClick={() =>
            form(
              t('이미지 가져오기'),
              [
                {
                  key: 'image',
                  label: t('이미지 주소'),
                  required: true,
                  placeholder: 'nginx:alpine',
                },
              ],
              (v) => job('pullImage', v),
            )
          }
        />
      </PageActions>
      <div className={tw.gridPanel}>
        <Toolbar search={search} onSearch={setSearch} />
        <ResourceGrid query={{ ...data, data: sortedData }} columns={cols} filter={search} />
      </div>
      {layerInspectImage && (
        <ImageLayerModal
          image={layerInspectImage}
          onClose={() => setLayerInspectImage(null)}
        />
      )}
      <PruneConfirmModal
        isOpen={pruneModalOpen}
        onClose={() => setPruneModalOpen(false)}
        kind="images"
        busy={busy}
        onConfirm={async () => {
          setPruneModalOpen(false);
          await job('pruneImages');
        }}
      />
    </section>
  );
}
export default Images;
