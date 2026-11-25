import { t, useLocale, languages, setLanguage, formatDate } from '../i18n.js';
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
  ['remote', '원격 접속'],
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
      {locked && ['engine', 'kubernetes', 'proxy'].includes(tab) && (
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
              {status?.managed !== false && <WslResources />}
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
              <fieldset disabled={saving} className={fieldset}>
                <label className={tw.checkbox}>
                  <input
                    type="checkbox"
                    checked={value.autoStart}
                    onChange={(e) => setValue({ ...value, autoStart: e.target.checked })}
                  />{' '}
                  {t('Naru 서버 시작 시 엔진도 시작')}{' '}
                </label>
                <label className={tw.checkbox}>
                  <input
                    type="checkbox"
                    checked={value.watchWindowsFolders}
                    onChange={(e) => setValue({ ...value, watchWindowsFolders: e.target.checked })}
                  />{' '}
                  {t('Windows 폴더 변경 감지')}{' '}
                </label>
                <p className={cn(tw.groupText, '-mt-1 pl-6.5 leading-[1.6]')}>
                  {t(
                    '컨테이너에 연결한 Windows 폴더에서 파일을 저장하면 컨테이너 안의 개발 서버가 알아채도록 알립니다. node_modules와 .git 폴더는 제외합니다.',
                  )}
                </p>
              </fieldset>
              <LaunchAtLogin />
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
          {tab === 'remote' && <RemoteAccess />}
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
                  '약 {0}를 Windows에 돌려줍니다. PC 화면에 관리자 권한 승인 창(UAC)이 뜨면 2분 안에 승인해 주세요. 승인한 뒤에 엔진과 컨테이너가 멈추고(약 10분), 끝나면 실행 중이던 컨테이너까지 다시 시작합니다. 디스크가 풀리지 않으면 다른 WSL 배포판도 함께 종료합니다.',
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
          {d.last && <LastCompaction last={d.last} />}
        </div>
      )}
    </section>
  );
}

function LastCompaction({ last }) {
  const at = formatDate(last.at);
  return (
    <small className={cn(tw.groupText, 'basis-full')}>
      {last.result === 'done'
        ? t('마지막 압축 {0}: {1} 회수', [at, gb(Math.max(0, last.before - last.after))])
        : last.result === 'skipped'
          ? t('마지막 압축 {0}: 건너뜀, {1}', [at, last.reason])
          : t('마지막 압축 {0}: 실패, {1}', [at, last.reason])}
    </small>
  );
}

function WslResources() {
  useLocale();
  const { notify, confirm } = useActions();
  const q = useData('wsl-config', '/wsl/config');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [savedNeedRestart, setSavedNeedRestart] = useState(false);

  useEffect(() => {
    if (q.data && !form) {
      setForm({
        processors: q.data.processors ?? '',
        memoryGb: q.data.memoryGb ?? '',
        autoMemoryReclaim: q.data.autoMemoryReclaim ?? '',
      });
    }
  }, [q.data, form]);

  if (q.error || !form) return null;

  const save = async () => {
    setSaving(true);
    try {
      await api('/wsl/config', {
        method: 'PUT',
        body: {
          processors: form.processors === '' ? null : Number(form.processors),
          memoryGb: form.memoryGb === '' ? null : Number(form.memoryGb),
          autoMemoryReclaim: form.autoMemoryReclaim || null,
        },
      });
      await q.refetch();
      setSavedNeedRestart(true);
      notify(t('WSL 설정을 저장했습니다. 적용하려면 WSL을 재시작해 주세요.'));
    } catch (e) {
      notify(e);
    } finally {
      setSaving(false);
    }
  };

  const restartWsl = () =>
    confirm(
      t('WSL 재시작'),
      t(
        'wsl --shutdown을 실행해 WSL 2 가상 머신을 종료합니다. Naru 엔진과 실행 중인 다른 WSL 배포판도 함께 멈춥니다. 그 뒤 엔진을 다시 시작하면 새 설정이 적용됩니다.',
      ),
      async () => {
        setRestarting(true);
        try {
          await api('/wsl/shutdown', { method: 'POST' });
          setSavedNeedRestart(false);
          notify(t('WSL을 종료했습니다. 엔진을 다시 시작해 주세요.'));
        } catch (e) {
          notify(e);
        } finally {
          setRestarting(false);
        }
      },
    );

  return (
    <section className="mb-8">
      <h3>{t('WSL 리소스 (.wslconfig)')}</h3>
      <p className={cn(tw.groupText, 'mb-3 leading-[1.6]')}>
        {t(
          '사용자 폴더의 .wslconfig에서 [wsl2] CPU, 메모리와 메모리 회수 항목만 수정하고 나머지 설정은 보존합니다. 비워 두면 WSL 기본값을 사용합니다.',
        )}
      </p>
      <div className={tw.formRow}>
        <label className={tw.field}>
          <span>{t('CPU 코어 수 (최대 {0})', [q.data.hostCpus])}</span>
          <input
            type="number"
            min="1"
            max={q.data.hostCpus}
            placeholder={t('자동')}
            value={form.processors}
            onChange={(e) => setForm({ ...form, processors: e.target.value })}
          />
        </label>
        <label className={tw.field}>
          <span>{t('메모리 (GB)')}</span>
          <input
            type="number"
            min="1"
            max="512"
            placeholder={t('자동')}
            value={form.memoryGb}
            onChange={(e) => setForm({ ...form, memoryGb: e.target.value })}
          />
        </label>
        <label className={tw.field}>
          <span>{t('메모리 회수 (autoMemoryReclaim)')}</span>
          <SelectControl
            className="w-full py-2.75"
            value={form.autoMemoryReclaim}
            onChange={(e) => setForm({ ...form, autoMemoryReclaim: e.target.value })}
          >
            <option value="">{t('기본값')}</option>
            <option value="gradual">{t('gradual (유휴 시 점진 회수)')}</option>
            <option value="dropcache">{t('dropcache (캐시 즉시 회수)')}</option>
            <option value="disabled">{t('disabled (사용 안 함)')}</option>
          </SelectControl>
        </label>
      </div>
      <div className={cn(tw.actions, 'mt-3')}>
        <Button icon={Check} disabled={saving || restarting} onClick={save}>
          {t('WSL 설정 저장')}
        </Button>
        <Button icon={RotateCw} disabled={saving || restarting} onClick={restartWsl}>
          {t('WSL 재시작')}
        </Button>
        {savedNeedRestart && (
          <small className={tw.groupText}>
            {t('바뀐 설정은 WSL을 재시작해야 적용되며, 다른 배포판도 함께 멈춥니다.')}
          </small>
        )}
      </div>
    </section>
  );
}

function ConnectionTools() {
  useLocale();
  const { job, form, busy, status } = useActions();
  const cli = useData('cli-status', '/cli/status');
  const cliInfo = cli.data;
  return (
    <section>
      {cliInfo?.conflict && (
        <div className="mb-5 rounded-[9px] border border-[#e0b86c] bg-[#fdf7ea] px-4 py-3.5 text-[13px] leading-[1.6] text-ink">
          <strong className="block">
            {cliInfo.dockerDesktop
              ? t('PATH에서 Docker Desktop의 docker CLI가 먼저 잡힙니다')
              : t('PATH에서 다른 docker CLI가 먼저 잡힙니다')}
          </strong>
          <p className="mt-1 text-muted">
            {t('현재 우선 실행되는 경로: {0}', [cliInfo.active])}
          </p>
          <p className="mt-1 text-muted">
            {t(
              'Windows는 시스템 PATH를 사용자 PATH보다 먼저 찾습니다. 다른 docker CLI에서도 docker context use naru로 Naru 엔진을 그대로 쓸 수 있고, Naru의 CLI를 우선 쓰려면 시스템 PATH 순서를 조정해 주세요.',
            )}
          </p>
        </div>
      )}
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
// Tailscale serve로 다른 기기에서 접속할 때의 허용 대상. 저장하면 서버를 다시 시작하지 않아도 바로 적용된다.
// 설정 저장 버튼과 따로, 바꾸는 즉시 Windows 시작 프로그램에 반영한다.
// 알림은 확인 창이라 성공 때는 띄우지 않고, 바뀐 체크 상태로 결과를 보여 준다.
function LaunchAtLogin() {
  useLocale();
  const { notify } = useActions();
  const data = useData('launch-at-login', '/app/launch-at-login');
  const [saving, setSaving] = useState(false);
  if (!data.data) return null;
  const { packaged, enabled } = data.data;
  const change = async (next) => {
    setSaving(true);
    try {
      await api('/app/launch-at-login', { method: 'PUT', body: { enabled: next } });
      await data.refetch();
    } catch (e) {
      notify(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <label className={cn(tw.checkbox, !packaged && 'opacity-60')}>
      <input
        type="checkbox"
        checked={enabled}
        disabled={!packaged || saving}
        onChange={(e) => change(e.target.checked)}
      />{' '}
      <span>
        {t('Windows에 로그인하면 창 없이 알림 영역(트레이)에서 Naru 시작')}
        {!packaged && (
          <small className="ml-2 text-[11px] text-muted">
            {t('설치된 앱에서 설정할 수 있습니다')}
          </small>
        )}
      </span>
    </label>
  );
}
function RemoteAccess() {
  useLocale();
  const { notify } = useActions();
  const data = useData('remote-access', '/remote-access');
  const [value, setValue] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data.data && !value) setValue({ host: data.data.host, users: data.data.users.join('\n') });
  }, [data.data, value]);
  if (data.error) return <ErrorState error={data.error} />;
  if (!value) return <Skeleton />;
  const save = async (body) => {
    setSaving(true);
    try {
      await api('/remote-access', { method: 'PUT', body });
      await data.refetch();
      setValue(null);
      notify(body.host ? t('원격 접속 설정을 저장했습니다.') : t('원격 접속을 껐습니다.'));
    } catch (e) {
      notify(e);
    } finally {
      setSaving(false);
    }
  };
  const users = value.users
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);
  return (
    <section className="max-w-[760px]">
      <p className={cn(tw.groupText, 'mb-5 leading-[1.7]')}>
        {t(
          '같은 tailnet의 다른 기기에서 Naru 화면을 열 수 있습니다. 허용한 계정만 접속하며, 이 설정은 이 PC에서만 바꿀 수 있습니다',
        )}
      </p>
      <label className={tw.field}>
        <span>{t('Tailscale 호스트')}</span>
        <input
          value={value.host}
          placeholder="my-pc.tailnet-name.ts.net:8461"
          spellCheck={false}
          onChange={(e) => setValue({ ...value, host: e.target.value })}
        />
      </label>
      <label className={tw.field}>
        <span>{t('허용할 tailnet 계정 (한 줄에 하나)')}</span>
        <textarea
          rows={4}
          value={value.users}
          spellCheck={false}
          placeholder="me@example.com"
          onChange={(e) => setValue({ ...value, users: e.target.value })}
        />
      </label>
      <p className={cn(tw.groupText, 'mt-4 mb-5')}>
        {t('이 PC에서 다음 명령으로 Tailscale serve를 켜 주세요')}
        <code className="mt-2 block rounded-[7px] bg-[#f3f6ef] px-3 py-2.5 font-mono text-[12px] text-ink">
          tailscale serve --bg --https={value.host.split(':')[1] || '443'} http://127.0.0.1:
          {data.data.port}
        </code>
      </p>
      <div className={tw.actions}>
        <Button
          primary
          icon={Check}
          disabled={saving || !value.host.trim() || !users.length}
          onClick={() => save({ host: value.host, users })}
        >
          {t('원격 접속 저장')}
        </Button>
        {data.data.enabled && (
          <Button disabled={saving} onClick={() => save({ host: '', users: [] })}>
            {t('원격 접속 끄기')}
          </Button>
        )}
      </div>
    </section>
  );
}

export default Settings;
