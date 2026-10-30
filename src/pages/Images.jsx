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
  ShieldCheck,
  CircleCheck,
  TriangleAlert,
} from 'lucide-react';
import {
  useActions,
  useData,
  Button,
  IconButton,
  RowMenu,
  Badge,
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

  const maxSize = useMemo(() => Math.max(1, ...layers.map((l) => l.sizeNum || 0)), [layers]);

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

// docker pull은 레이어마다 상태 줄을 남기고, nerdctl은 layer-sha256 접두어로 상태를 남긴다. 상태 단계를 진행률로 환산한다.
const PULL_STEPS = [
  [/already exists|exists|pull complete|^done/i, 1],
  [/extracting/i, 0.85],
  [/download complete/i, 0.7],
  [/verifying/i, 0.6],
  [/downloading/i, 0.35],
];
export function pullProgress(log = '') {
  const layers = new Map();
  let image = '';
  for (const line of log.split(/\r?\n/)) {
    const from = line.match(/Pulling from (\S+)/);
    if (from) image = from[1];
    const layer =
      line.match(/^([0-9a-f]{12}): (.+)$/) ||
      line.match(/^layer-sha256:([0-9a-f]{12})[0-9a-f]*:\s+(\w+)/);
    if (layer) layers.set(layer[1], layer[2].trim());
  }
  return {
    image,
    layers: [...layers].map(([id, state]) => ({
      id,
      state,
      progress: PULL_STEPS.find(([pattern]) => pattern.test(state))?.[1] ?? 0.05,
    })),
  };
}

// 분석 작업은 마지막에 이미지 이름과 심각도별 개수를 JSON으로 남긴다.
export function scanSummary(log = '') {
  const start = log.lastIndexOf('{\n  "image"');
  if (start < 0) return null;
  try {
    return JSON.parse(log.slice(start, log.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

const SEVERITIES = [
  ['CRITICAL', 'Critical', '#ba5b57'],
  ['HIGH', 'High', '#d9844a'],
  ['MEDIUM', 'Medium', '#cfa53c'],
  ['LOW', 'Low', '#7fae8b'],
  ['UNKNOWN', 'Unknown', '#a9b2ac'],
];
const active = (j) => ['queued', 'running'].includes(j?.state);

function PullCard({ pull, image, onClose }) {
  useLocale();
  const detail = useData('job:' + pull.id, '/jobs/' + pull.id, {
    refetchInterval: active(pull) ? 1000 : false,
  });
  const { image: parsed, layers } = pullProgress(detail.data?.log);
  const name = image || parsed || t('이미지');
  const shown = layers.slice(0, 6);
  return (
    <div className={cn(tw.panel, 'flex flex-none flex-col gap-2.5 px-5 py-4 max-tablet:px-4')}>
      <div className="flex min-h-8.5 items-center gap-2.5 text-[14px] font-semibold">
        {active(pull) ? (
          <LoaderCircle size={17} className="flex-none animate-spin text-accent" />
        ) : pull.state === 'failed' ? (
          <TriangleAlert size={17} className="flex-none text-danger" />
        ) : (
          <CircleCheck size={17} className="flex-none text-accent" />
        )}
        <span className="min-w-0 truncate">
          {active(pull)
            ? t('{0} 가져오는 중', [name])
            : pull.state === 'failed'
              ? t('{0} 가져오기 실패', [name])
              : t('{0} 가져오기 완료', [name])}
        </span>
        {layers.length > 0 && (
          <span className="ml-auto flex-none text-[12px] font-medium text-muted">
            {t('{0}개 레이어', [layers.length])}
          </span>
        )}
        {!active(pull) && (
          <IconButton
            icon={X}
            label={t('닫기')}
            className={layers.length ? '' : 'ml-auto'}
            onClick={onClose}
          />
        )}
      </div>
      {pull.state === 'failed' && pull.error && (
        <p className="text-[12px] whitespace-pre-wrap wrap-anywhere text-[#b24639]">{pull.error}</p>
      )}
      {active(pull) && !layers.length && (
        <div
          className="skeleton-smooth h-1.75 rounded-full"
          role="progressbar"
          aria-label={t('가져오는 중')}
        />
      )}
      {shown.map((layer) => (
        <div
          key={layer.id}
          className="grid grid-cols-[110px_minmax(0,1fr)_140px] items-center gap-3 text-[12px] text-muted max-tablet:grid-cols-[90px_minmax(0,1fr)]"
        >
          <span className="font-mono">{layer.id}</span>
          <div className="h-1.75 overflow-hidden rounded-full bg-[#edf0ea]">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-500',
                layer.progress >= 1 ? 'bg-[#6aa887]' : 'bg-accent',
              )}
              style={{ width: `${layer.progress * 100}%` }}
            />
          </div>
          <span className="truncate text-right max-tablet:hidden">{layer.state}</span>
        </div>
      ))}
      {layers.length > shown.length && (
        <p className="text-[12px] text-muted">
          {t('그 밖의 레이어 {0}개', [layers.length - shown.length])}
        </p>
      )}
    </div>
  );
}

function ScanPanel({ scan, image }) {
  useLocale();
  const detail = useData('job:' + scan.id, '/jobs/' + scan.id, {
    refetchInterval: active(scan) ? 2000 : false,
  });
  const summary = scan.state === 'succeeded' ? scanSummary(detail.data?.log) : null;
  const report = useData('scan:' + scan.id, '/scans/' + scan.id, {
    enabled: scan.state === 'succeeded',
    staleTime: Infinity,
  });
  const colorOf = Object.fromEntries(SEVERITIES.map(([key, , color]) => [key, color]));
  const counts = summary?.severityCounts || {};
  const max = Math.max(1, ...Object.values(counts));
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return (
    <aside
      aria-label={t('취약점 분석')}
      className={cn(
        tw.panel,
        // 목록 옆에서 세로 공간을 모두 쓰고, 상세 목록만 따로 스크롤한다.
        'flex min-h-0 w-[360px] flex-none flex-col gap-3.5 p-5 wide:w-[400px] max-desktop:h-[560px] max-desktop:w-full max-tablet:p-4',
      )}
    >
      <div className="flex items-center gap-2.5 text-[14px] font-semibold">
        <ShieldCheck size={17} className="flex-none text-accent" />
        {t('취약점 분석')}
        {active(scan) && (
          <span className="ml-auto">
            <Badge tone="wait">{t('분석 중')}</Badge>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="truncate font-mono text-[12px] text-ink">
          {summary?.image || image || '-'}
        </span>
        {scan.finishedAt && (
          <span className="text-[11px] text-muted">{formatDate(scan.finishedAt)}</span>
        )}
      </div>
      {scan.state === 'failed' ? (
        <p className="text-[12px] whitespace-pre-wrap wrap-anywhere text-[#b24639]">
          {scan.error || t('분석에 실패했습니다')}
        </p>
      ) : summary ? (
        <>
          <div className="flex flex-col gap-2.5">
            {SEVERITIES.filter(([key]) => key !== 'UNKNOWN' || counts.UNKNOWN).map(
              ([key, label, color]) => (
                <div
                  key={key}
                  className="grid grid-cols-[76px_minmax(0,1fr)_36px] items-center gap-2.5 text-[12px]"
                >
                  <span className="flex items-center gap-2">
                    <i className="h-2.25 w-2.25 rounded-[3px]" style={{ background: color }} />
                    {label}
                  </span>
                  <div className="h-1.75 overflow-hidden rounded-full bg-[#edf0ea]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${((counts[key] || 0) / max) * 100}%`, background: color }}
                    />
                  </div>
                  <b className="text-right font-display text-[16px] tabular-nums">
                    {counts[key] || 0}
                  </b>
                </div>
              ),
            )}
          </div>
          <p className="rounded-[9px] bg-[#f3f7ee] px-3.5 py-2.5 text-[12px] text-accent">
            {total ? t('발견된 취약점 {0}건', [total]) : t('발견된 취약점이 없어요')}
          </p>
          {total > 0 && (
            <ul
              aria-label={t('취약점 상세')}
              className="-mx-5 min-h-0 flex-1 overflow-y-auto border-t border-line px-5 max-tablet:-mx-4 max-tablet:px-4"
            >
              {report.isLoading ? (
                [1, 2, 3].map((i) => (
                  <li
                    key={i}
                    className="skeleton-smooth my-3 h-12 rounded-[8px]"
                    aria-hidden="true"
                  />
                ))
              ) : report.error ? (
                <li className="py-3 text-[12px] text-[#b24639]">{report.error.message}</li>
              ) : (
                report.data?.vulnerabilities.map((v, index) => (
                  <li
                    key={`${v.id}-${v.package}-${index}`}
                    className="flex flex-col gap-1 border-b border-[#eef1eb] py-2.75 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <i
                        className="h-2.25 w-2.25 flex-none rounded-[3px]"
                        style={{ background: colorOf[v.severity] || colorOf.UNKNOWN }}
                        aria-label={v.severity}
                      />
                      {v.url ? (
                        <a
                          href={v.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate font-mono text-[12px] font-semibold text-ink hover:underline"
                        >
                          {v.id}
                        </a>
                      ) : (
                        <span className="truncate font-mono text-[12px] font-semibold">{v.id}</span>
                      )}
                      <span className="ml-auto flex-none text-[11px] text-muted">{v.severity}</span>
                    </div>
                    {v.title && <p className="line-clamp-2 text-[12px] text-ink">{v.title}</p>}
                    <p className="truncate font-mono text-[11px] text-muted" title={v.target}>
                      {v.package} {v.installed}
                      {' → '}
                      {v.fixed || t('수정 버전 없음')}
                    </p>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton-smooth h-3.5 rounded-[5px]" />
          ))}
        </div>
      )}
    </aside>
  );
}

function Images() {
  const locale = useLocale();
  const { status, job, form, confirm, busy } = useActions(),
    data = useResource('images');
  const [search, setSearch] = useState(''),
    [layerInspectImage, setLayerInspectImage] = useState(null),
    [pruneModalOpen, setPruneModalOpen] = useState(false),
    [submitted, setSubmitted] = useState({}),
    [closedPull, setClosedPull] = useState(null);
  // 작업 기록은 새 작업이 앞에 온다. 이 화면에서 요청한 이미지 이름은 작업 ID별로 기억해 진행 중에도 보여 준다.
  const jobs = useData('jobs', '/jobs');
  const pull = jobs.data?.find((j) => j.type === 'pullImage');
  const scan = jobs.data?.find((j) => j.type === 'scanImage');
  const showPull =
    pull &&
    pull.id !== closedPull &&
    (active(pull) || Date.now() - new Date(pull.finishedAt || pull.createdAt) < 10 * 60000);
  const track = (image) => (result) =>
    result && setSubmitted((current) => ({ ...current, [result.id]: image }));
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
        width: 136,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <div className={tw.rowActions}>
            <IconButton
              label={t('{0} 실행', [imageName(r)])}
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
              label={t('{0} 취약점 분석', [imageName(r)])}
              icon={ShieldCheck}
              disabled={busy}
              onClick={() => job('scanImage', { image: imageName(r) }).then(track(imageName(r)))}
            />
            <RowMenu
              label={t('{0} 작업 더 보기', [imageName(r)])}
              items={[
                {
                  icon: Layers,
                  label: t('레이어 용량 분석'),
                  onClick: () =>
                    setLayerInspectImage({ id: r.Id, name: imageName(r), size: r.Size }),
                },
                {
                  icon: Download,
                  label: t('이미지 내보내기'),
                  disabled: busy,
                  onClick: () =>
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
                    ),
                },
                {
                  icon: Tag,
                  label: t('태그 추가'),
                  disabled: busy,
                  onClick: () =>
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
                    ),
                },
                {
                  icon: ArrowUpRight,
                  label: t('레지스트리로 보내기'),
                  disabled: busy,
                  onClick: () =>
                    confirm(
                      t('이미지 보내기'),
                      t('{0} 이미지를 지정된 레지스트리에 보냅니다.', [imageName(r)]),
                      () => job('pushImage', { image: imageName(r) }),
                    ),
                },
                {
                  icon: Trash2,
                  label: t('이미지 삭제'),
                  danger: true,
                  disabled: busy,
                  onClick: () =>
                    confirm(
                      t('이미지 삭제'),
                      t('{0} 이미지를 삭제합니다. 사용 중인 이미지는 엔진이 보호합니다.', [
                        imageName(r),
                      ]),
                      () => job('removeImage', { id: r.Id }),
                    ),
                },
              ]}
            />
          </div>
        ),
      },
    ],
    [locale, busy, form, job, confirm],
  );
  if (!status?.ready) return status ? <RuntimeEmpty /> : <Skeleton />;
  return (
    // 넓은 화면에서는 화면 높이에 맞춰 목록과 분석 패널이 각자 스크롤한다.
    <section className={cn(tw.page, 'desktop:h-full')}>
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
              (v) => job('pullImage', v).then(track(v.image)),
            )
          }
        />
      </PageActions>
      {showPull && (
        <PullCard pull={pull} image={submitted[pull.id]} onClose={() => setClosedPull(pull.id)} />
      )}
      <div className="flex min-h-0 flex-1 gap-4 max-desktop:flex-col">
        <div className={tw.gridPanel}>
          <Toolbar search={search} onSearch={setSearch} />
          <ResourceGrid query={{ ...data, data: sortedData }} columns={cols} filter={search} />
        </div>
        {scan && <ScanPanel scan={scan} image={submitted[scan.id]} />}
      </div>
      {layerInspectImage && (
        <ImageLayerModal image={layerInspectImage} onClose={() => setLayerInspectImage(null)} />
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
