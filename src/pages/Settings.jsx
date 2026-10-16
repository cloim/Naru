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
  Skeleton,
  ErrorState,
  PageActions,
  PageAction,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
function Settings() {
  const data = useData('settings', '/settings'),
    { status, notify } = useActions(),
    qc = useQueryClient();
  const [value, setValue] = useState(null),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data.data && !value) setValue(data.data);
  }, [data.data, value]);
  if (data.error) return <ErrorState error={data.error} />;
  if (!value) return <Skeleton />;
  const locked = !!status?.running && status?.managed !== false;
  return (
    <section className={cn(tw.page, 'max-w-[1150px]')}>
      <PageActions>
        <PageAction
          label="설정 저장"
          primary
          icon={Check}
          disabled={locked || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api('/settings', { method: 'PUT', body: value });
              qc.invalidateQueries();
              notify('설정을 저장했습니다.');
            } catch (e) {
              notify(e);
            } finally {
              setSaving(false);
            }
          }}
        />
      </PageActions>
      <section className={cn(tw.panel, tw.group)}>
        <h3>연결할 엔진</h3>
        <SelectControl
          aria-label="엔진 연결"
          disabled={locked || saving}
          value={value.connection}
          onChange={(e) => setValue({ ...value, connection: e.target.value, engine: 'moby' })}
        >
          <option value="external-engine">External Engine의 Docker 엔진 공유</option>
          <option value="managed">Naru 독립 엔진</option>
        </SelectControl>
        {(locked || value.connection === 'external-engine') && (
          <p className={cn(tw.groupText, 'mt-3')}>
            {locked
              ? '설정을 변경하려면 엔진을 정상 종료해 주세요.'
              : '공유 모드에서는 엔진 설정을 External Engine에서 관리합니다.'}
          </p>
        )}
      </section>
      <fieldset
        disabled={locked || saving || value.connection === 'external-engine'}
        className="m-0 border-0 p-0 disabled:opacity-65"
      >
        <section className={cn(tw.panel, tw.group)}>
          <h3>컨테이너 엔진</h3>
          <div className="mb-5.5 flex gap-3.5 max-desktop:flex-col">
            {[
              ['moby', 'Docker (Moby)'],
              ['containerd', 'containerd'],
            ].map(([key, title]) => (
              <label
                className={cn(
                  'flex flex-1 items-center gap-3 rounded-[9px] border border-line p-5 [&_input]:accent-brand',
                  value.engine === key && 'border-[#4f7750] bg-[#f6faef]',
                )}
                key={key}
              >
                <input
                  type="radio"
                  name="engine"
                  checked={value.engine === key}
                  onChange={() => setValue({ ...value, engine: key })}
                />
                <strong>{title}</strong>
              </label>
            ))}
          </div>
          <label className={tw.field}>
            <span>containerd 네임스페이스</span>
            <input
              value={value.namespace}
              onChange={(e) => setValue({ ...value, namespace: e.target.value })}
            />
          </label>
        </section>
        <section className={cn(tw.panel, tw.group)}>
          <h3>Kubernetes</h3>
          <label className={tw.checkbox}>
            <input
              type="checkbox"
              checked={value.kubernetes.enabled}
              onChange={(e) =>
                setValue({
                  ...value,
                  kubernetes: { ...value.kubernetes, enabled: e.target.checked },
                })
              }
            />
            엔진 시작 시 Kubernetes도 시작
          </label>
          <div className={tw.formRow}>
            <label className={tw.field}>
              <span>k3s 버전</span>
              <input
                value={value.kubernetes.version}
                onChange={(e) =>
                  setValue({
                    ...value,
                    kubernetes: { ...value.kubernetes, version: e.target.value },
                  })
                }
              />
            </label>
            <label className={tw.field}>
              <span>API 포트</span>
              <input
                type="number"
                min="1024"
                max="65535"
                value={value.kubernetes.port}
                onChange={(e) =>
                  setValue({
                    ...value,
                    kubernetes: { ...value.kubernetes, port: Number(e.target.value) },
                  })
                }
              />
            </label>
          </div>
          <label className={tw.checkbox}>
            <input
              type="checkbox"
              checked={value.kubernetes.traefik}
              onChange={(e) =>
                setValue({
                  ...value,
                  kubernetes: { ...value.kubernetes, traefik: e.target.checked },
                })
              }
            />
            Traefik Ingress 사용
          </label>
        </section>
        <section className={cn(tw.panel, tw.group)}>
          <h3>프록시</h3>
          {[
            ['http', 'HTTP_PROXY'],
            ['https', 'HTTPS_PROXY'],
            ['noProxy', 'NO_PROXY'],
          ].map(([key, label]) => (
            <label className={tw.field} key={key}>
              <span>{label}</span>
              <input
                autoComplete="off"
                type={key === 'noProxy' ? 'text' : 'password'}
                value={value.proxy[key]}
                onChange={(e) =>
                  setValue({ ...value, proxy: { ...value.proxy, [key]: e.target.value } })
                }
              />
            </label>
          ))}
        </section>
        <section className={cn(tw.panel, tw.group)}>
          <h3>화면 갱신</h3>
          <label className={tw.field}>
            <span>자동 갱신 간격, 초</span>
            <input
              type="number"
              min="3"
              max="60"
              value={value.pollSeconds}
              onChange={(e) => setValue({ ...value, pollSeconds: Number(e.target.value) })}
            />
          </label>
        </section>
      </fieldset>
      <ConnectionTools />
    </section>
  );
}

function ConnectionTools() {
  const { job, form, busy, status } = useActions();
  return (
    <section className={cn(tw.panel, tw.group)}>
      <h3>CLI와 레지스트리</h3>
      <div className={tw.actions}>
        <Button icon={Terminal} disabled={busy} onClick={() => job('installCLI')}>
          Windows CLI 설치
        </Button>
        <Button
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              '레지스트리 로그인',
              [
                {
                  key: 'server',
                  label: '레지스트리',
                  value: 'https://index.docker.io/v1/',
                  required: true,
                },
                { key: 'username', label: '사용자 이름', required: true },
                {
                  key: 'password',
                  label: '비밀번호 또는 접근 토큰',
                  type: 'password',
                  required: true,
                },
              ],
              (v) => job('registryLogin', v),
              'Docker 자격 증명 도우미를 통해 현재 Windows 사용자의 자격 증명 저장소에 보관합니다.',
            )
          }
        >
          레지스트리 로그인
        </Button>
        <Button
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              '레지스트리 로그아웃',
              [
                {
                  key: 'server',
                  label: '레지스트리',
                  value: 'https://index.docker.io/v1/',
                  required: true,
                },
              ],
              (v) => job('registryLogout', v),
            )
          }
        >
          로그아웃
        </Button>
      </div>
    </section>
  );
}
export default Settings;
