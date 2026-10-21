import { t, useLocale, languages, setLanguage } from '../i18n.js';
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
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
  Badge,
} from '../ui.jsx';
import { cn, tw } from '../tw.js';
import { api, downloadConfig } from '../api.js';
import { Modal } from '../components/Modal/Modal.jsx';
import SelectControl from '../components/SelectControl/SelectControl.tsx';
const SETTING_TABS = [
  ['engine', '엔진'],
  ['kubernetes', 'Kubernetes'],
  ['proxy', '프록시'],
  ['screen', '화면'],
  ['cli', 'CLI와 레지스트리'],
];
const fieldset = 'm-0 min-w-0 border-0 p-0 disabled:opacity-65';
function Settings() {
  const locale = useLocale();
  const data = useData('settings', '/settings'),
    { status, notify, job, confirm, busy } = useActions(),
    qc = useQueryClient();
  const [value, setValue] = useState(null),
    [saving, setSaving] = useState(false),
    [params, setParams] = useSearchParams();
  const tab = SETTING_TABS.some(([key]) => key === params.get('tab'))
    ? params.get('tab')
    : 'engine';
  useEffect(() => {
    if (data.data && !value) setValue(data.data);
  }, [data.data, value]);
  if (data.error) return <ErrorState error={data.error} />;
  if (!value) return <Skeleton />;
  const locked = !!status?.running;
  const managedLocked = locked || saving;
  return (
    <section className={cn(tw.page, 'max-w-[1150px]')}>
      <PageActions>
        <PageAction
          label={t('설정 저장')}
          primary
          icon={Check}
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api('/settings', { method: 'PUT', body: value });
              qc.invalidateQueries();
              notify(t('설정을 저장했습니다.'));
            } catch (e) {
              notify(e);
            } finally {
              setSaving(false);
            }
          }}
        />
      </PageActions>
      {locked &&
        ['engine', 'kubernetes', 'proxy'].includes(tab) && (
          <p className={cn(tw.panel, tw.groupText, 'px-5 py-3.5')}>
            {t(
              '엔진, Kubernetes와 프록시 설정은 엔진을 정상 종료한 뒤 바꿀 수 있습니다. 서버 시작 시 엔진 자동 시작과 화면 설정은 바로 저장됩니다.',
            )}
          </p>
        )}
      <div className={cn(tw.panel, 'flex flex-col')}>
        <div className={tw.tabs} role="tablist" aria-label={t('설정 분류')}>
          {SETTING_TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={cn(tw.tab, tab === key && tw.tabSelected)}
              onClick={() => setParams({ tab: key }, { replace: true })}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="px-7.5 py-6.5 max-tablet:px-5 max-tablet:py-5.5 [&_h3]:mb-4.5">
          {tab === 'engine' && (
            <>
              {status && status.managed !== false && (
                <section className="mb-8">
                  <h3>{t('엔진 실행')}</h3>
                  <div className="flex flex-wrap items-center gap-3.5">
                    <Badge state={status.running ? 'running' : 'exited'}>
                      {!status.installed
                        ? t('설치 안 됨')
                        : status.running
                          ? t('실행 중')
                          : t('꺼짐')}
                    </Badge>
                    {!status.installed ? (
                      <Button
                        primary
                        icon={Download}
                        disabled={busy}
                        onClick={() => job('installRuntime')}
                      >
                        {' '}
                        {t('런타임 설치')}{' '}
                      </Button>
                    ) : status.running ? (
                      <Button
                        icon={Square}
                        disabled={busy}
                        onClick={() =>
                          confirm(
                            t('엔진 종료'),
                            t('Naru의 컨테이너와 Kubernetes를 정상 종료합니다.'),
                            () => job('stopRuntime'),
                          )
                        }
                      >
                        {' '}
                        {t('엔진 종료')}{' '}
                      </Button>
                    ) : (
                      <Button
                        primary
                        icon={Play}
                        disabled={busy}
                        onClick={() => job('startRuntime')}
                      >
                        {' '}
                        {t('엔진 시작')}{' '}
                      </Button>
                    )}
                  </div>
                </section>
              )}
              {status?.installed && <DiskSpace />}
              <fieldset disabled={managedLocked} className={cn(fieldset, 'mb-8')}>
                <h3>{t('컨테이너 엔진')}</h3>
                <div className="mb-4 flex gap-3.5 max-desktop:flex-col">
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
                  <span>{t('containerd 네임스페이스')}</span>
                  <input
                    value={value.namespace}
                    onChange={(e) => setValue({ ...value, namespace: e.target.value })}
                  />
                </label>
              </fieldset>
              <fieldset
                disabled={saving}
                className={fieldset}
              >
                <label className={tw.checkbox}>
                  <input
                    type="checkbox"
                    checked={value.autoStart}
                    onChange={(e) => setValue({ ...value, autoStart: e.target.checked })}
                  />{' '}
                  {t('Naru 서버 시작 시 엔진도 시작')}{' '}
                </label>
              </fieldset>
            </>
          )}
          {tab === 'kubernetes' && (
            <fieldset disabled={managedLocked} className={fieldset}>
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
                />{' '}
                {t('엔진 시작 시 Kubernetes도 시작')}{' '}
              </label>
              <div className={tw.formRow}>
                <label className={tw.field}>
                  <span>{t('k3s 버전')}</span>
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
                  <span>{t('API 포트')}</span>
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
                />{' '}
                {t('Traefik Ingress 사용')}{' '}
              </label>
            </fieldset>
          )}
          {tab === 'proxy' && (
            <fieldset disabled={managedLocked} className={fieldset}>
              {[
                ['http', 'HTTP_PROXY'],
                ['https', 'HTTPS_PROXY'],
                ['noProxy', 'NO_PROXY'],
              ].map(([key, label]) => (
                <label className={tw.field} key={key}>
                  <span>{t(label)}</span>
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
            </fieldset>
          )}
          {tab === 'screen' && (
            <fieldset disabled={saving} className={fieldset}>
              <label className={tw.field}>
                <span>{t('언어')}</span>
                <SelectControl
                  className="w-full py-2.75"
                  aria-label={t('표시 언어')}
                  value={locale}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  {languages.map(([code, name]) => (
                    <option key={code} value={code} lang={code}>
                      {name}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label className={tw.field}>
                <span>{t('자동 갱신 간격, 초')}</span>
                <input
                  type="number"
                  min="3"
                  max="60"
                  value={value.pollSeconds}
                  onChange={(e) => setValue({ ...value, pollSeconds: Number(e.target.value) })}
                />
              </label>
            </fieldset>
          )}
          {tab === 'cli' && <ConnectionTools />}
        </div>
      </div>
    </section>
  );
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}GB`;

// 가상 디스크는 안에서 파일을 지워도 줄지 않으므로, 돌려받을 공간이 있을 때만 압축을 권한다.
function DiskSpace() {
  useLocale();
  const { job, confirm, busy, status } = useActions();
  const disk = useData('disk', '/disk', { refetchInterval: 30000 });
  const d = disk.data;
  const enough = d?.reclaimable >= d?.minReclaim;
  return (
    <section className="mb-8">
      <h3>{t('디스크 공간')}</h3>
      {disk.isLoading ? (
        <Skeleton />
      ) : disk.error ? (
        <ErrorState error={disk.error} retry={() => disk.refetch()} />
      ) : (
        <div className="flex flex-wrap items-center gap-3.5">
          <p className="text-[13px]">
            {t('가상 디스크 {0}', [gb(d.file)])}
            {d.used !== null && (
              <>
                {' '}
                {t('중 사용 {0}, 돌려받을 수 있는 공간 약 {1}', [gb(d.used), gb(d.reclaimable)])}
              </>
            )}
          </p>
          <Button
            icon={HardDrive}
            disabled={busy || !status?.running || !enough}
            onClick={() =>
              confirm(
                t('디스크 압축'),
                t(
                  '약 {0}를 Windows에 돌려줍니다. 압축하는 동안 엔진과 컨테이너가 멈추고(약 10분), 끝나면 다시 시작합니다. PC 화면에 관리자 권한 승인 창(UAC)이 뜨면 2분 안에 승인해 주세요.',
                  [gb(d.reclaimable)],
                ),
                () => job('compactDisk'),
              )
            }
          >
            {' '}
            {t('디스크 압축')}{' '}
          </Button>
          {!status?.running ? (
            <small className={tw.groupText}>
              {' '}
              {t('엔진이 켜져 있어야 사용량을 재고 압축할 수 있습니다.')}{' '}
            </small>
          ) : (
            !enough && (
              <small className={tw.groupText}>
                {t('돌려받을 공간이 {0} 미만입니다.', [gb(d.minReclaim)])}
              </small>
            )
          )}
        </div>
      )}
    </section>
  );
}

function ConnectionTools() {
  useLocale();
  const { job, form, busy, status } = useActions();
  return (
    <section>
      <div className={tw.actions}>
        <Button icon={Terminal} disabled={busy} onClick={() => job('installCLI')}>
          {' '}
          {t('Windows CLI 설치')}{' '}
        </Button>
        <Button
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              t('레지스트리 로그인'),
              [
                {
                  key: 'server',
                  label: t('레지스트리'),
                  value: 'https://index.docker.io/v1/',
                  required: true,
                },
                { key: 'username', label: t('사용자 이름'), required: true },
                {
                  key: 'password',
                  label: t('비밀번호 또는 접근 토큰'),
                  type: 'password',
                  required: true,
                },
              ],
              (v) => job('registryLogin', v),
              t(
                'Docker 자격 증명 도우미를 통해 현재 Windows 사용자의 자격 증명 저장소에 보관합니다.',
              ),
            )
          }
        >
          {' '}
          {t('레지스트리 로그인')}{' '}
        </Button>
        <Button
          disabled={busy || !status?.ready}
          onClick={() =>
            form(
              t('레지스트리 로그아웃'),
              [
                {
                  key: 'server',
                  label: t('레지스트리'),
                  value: 'https://index.docker.io/v1/',
                  required: true,
                },
              ],
              (v) => job('registryLogout', v),
            )
          }
        >
          {' '}
          {t('로그아웃')}{' '}
        </Button>
      </div>
    </section>
  );
}
export default Settings;
