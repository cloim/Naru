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
} from 'lucide-react';
import {
  useActions,
  Button,
  IconButton,
  Skeleton,
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
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Images() {
  const locale = useLocale();
  const { status, job, form, confirm, busy } = useActions(),
    data = useResource('images');
  const [search, setSearch] = useState('');
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
        width: 250,
        sortable: false,
        cellRenderer: ({ data: r }) => (
          <div className={tw.rowActions}>
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
    </section>
  );
}
export default Images;
