import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  HardDrive,
  LoaderCircle,
  Power,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { t, useLocale, languages, setLanguage } from '../i18n.js';
import { api } from '../api.js';
import { Button, bytes } from '../ui.jsx';
import { cn, tw } from '../tw.js';

const STEPS = [
  ['welcome', '시작'],
  ['check', '환경 점검'],
  ['storage', '위치와 포트'],
  ['engine', '엔진 구성'],
  ['install', '설치'],
];
const MIN_FREE = 20 * 1024 ** 3;
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,.svc,.cluster.local';

// 상태 한 줄: 아이콘 색으로 준비, 주의, 확인 중을 구분한다.
function CheckRow({ state, title, children, action }) {
  const Icon = {
    ok: Check,
    warn: TriangleAlert,
    error: CircleAlert,
    busy: LoaderCircle,
    wait: Circle,
  }[state];
  return (
    <li className="flex items-start gap-4 border-b border-line py-4.5 last:border-b-0 max-tablet:flex-wrap">
      <span
        className={cn(
          'mt-0.5 grid size-8 flex-none place-items-center rounded-full',
          state === 'ok' && 'bg-[#e6f2da] text-[#3f7134]',
          state === 'warn' && 'bg-[#fbf1dc] text-[#94661c]',
          state === 'error' && 'bg-[#faeeeb] text-danger',
          state === 'busy' && 'bg-[#eef1ea] text-muted',
          state === 'wait' && 'bg-[#f3f5f0] text-[#a3ada2]',
        )}
      >
        <Icon size={16} className={state === 'busy' ? 'animate-spin' : ''} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <strong className="text-[14px] text-ink">{title}</strong>
        <p className="mt-1 text-[12px] leading-[1.7] text-[#5f6e63]">{children}</p>
      </div>
      {action && <div className="flex-none max-tablet:w-full max-tablet:pl-12">{action}</div>}
    </li>
  );
}

// 선택지 카드: 라디오처럼 하나만 고르고, 키보드로도 이동한다.
function Choice({ selected, onSelect, title, children }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-1.5 rounded-[11px] border bg-paper px-5 py-4.5 text-left transition-[border-color,background] duration-150',
        selected
          ? 'border-accent bg-[#f4f9ee] shadow-[inset_0_0_0_1px_var(--color-accent)]'
          : 'border-line hover:border-[#c3d0c0]',
      )}
    >
      <span className="flex items-center justify-between gap-3 text-[14px] font-semibold text-ink">
        {title}
        <span
          className={cn(
            'grid size-4.5 place-items-center rounded-full border',
            selected ? 'border-accent bg-accent text-white' : 'border-[#c7d1c4]',
          )}
        >
          {selected && <Check size={11} strokeWidth={3} aria-hidden="true" />}
        </span>
      </span>
      <span className="text-[12px] leading-[1.65] text-[#617064]">{children}</span>
    </button>
  );
}

async function runJob(type, payload, onLog) {
  const job = await api('/jobs', { method: 'POST', body: { type, payload } });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const { job: current, log } = await api(`/jobs/${job.id}`);
    onLog(log);
    if (current.state === 'succeeded') return;
    if (current.state === 'failed') throw new Error(current.error || t('작업이 실패했습니다'));
  }
}

export default function Onboarding({ onDone }) {
  const locale = useLocale();
  const [step, setStep] = useState(0);
  const status = useQuery({ queryKey: ['onboarding-status'], queryFn: () => api('/onboarding') });
  const s = status.data;
  const [plan, setPlan] = useState({
    dataDir: '',
    port: '',
    launchAtLogin: true,
    engine: 'moby',
    kubernetes: false,
    installCli: true,
    http: '',
    https: '',
    noProxy: DEFAULT_NO_PROXY,
  });
  const [notice, setNotice] = useState(null);
  const [working, setWorking] = useState(false);
  const heading = useRef(null);
  const set = (patch) => setPlan((p) => ({ ...p, ...patch }));

  useEffect(() => {
    if (s && !plan.dataDir) set({ dataDir: s.dataDir, port: String(s.port) });
  }, [s]);
  // 단계가 바뀌면 화면 읽기 프로그램과 키보드 사용자가 새 제목에서 시작하도록 초점을 옮긴다.
  useEffect(() => heading.current?.focus(), [step]);

  const virt = s?.virtualization;
  const ready = s && s.wsl?.installed && virt?.ready;
  // 펌웨어 가상화가 꺼져 있거나, WSL까지 있는데 하이퍼바이저가 돌지 않으면 사용자 조치 없이는 진행할 수 없다.
  const blocked =
    s && !virt.ready && (virt.state === 'firmware' || (virt.state === 'platform' && s.wsl.installed));
  const key = STEPS[step][0];

  async function quitApp() {
    try {
      await api('/app/quit', { method: 'POST' });
    } catch (e) {
      setNotice(e.message);
    }
  }

  async function installWsl() {
    setWorking(true);
    setNotice(null);
    try {
      const result = await api('/onboarding/wsl', { method: 'POST' });
      setNotice(
        !result.restartRequired
          ? t('WSL을 설치했습니다')
          : s.packaged
            ? t(
                'PC를 다시 시작하면 WSL 설치가 끝나고, 로그인 후 Naru가 자동으로 열려 이어서 진행합니다',
              )
            : t('PC를 다시 시작하면 WSL 설치가 끝나고, 그 뒤 Naru를 열면 이어서 진행합니다'),
      );
      await status.refetch();
    } catch (e) {
      setNotice(e.message);
    } finally {
      setWorking(false);
    }
  }

  async function saveStorage() {
    setWorking(true);
    setNotice(null);
    try {
      const body = { dataDir: plan.dataDir, port: Number(plan.port) };
      if (s.packaged) body.launchAtLogin = plan.launchAtLogin;
      const result = await api('/onboarding', { method: 'PUT', body });
      if (result.restart) {
        setNotice(
          result.manualRestart
            ? t('바뀐 데이터 폴더나 포트를 쓰려면 Naru 서버를 다시 시작해 주세요')
            : t('바뀐 설정을 적용하려고 Naru를 다시 시작합니다'),
        );
        return;
      }
      setStep(3);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setWorking(false);
    }
  }

  const next = () => {
    setNotice(null);
    if (key === 'storage') return saveStorage();
    setStep((n) => Math.min(n + 1, STEPS.length - 1));
  };
  const canNext =
    key === 'check'
      ? ready
      : key === 'storage'
        ? !!plan.dataDir.trim() && /^\d{4,5}$/.test(plan.port)
        : true;

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas max-tablet:flex-col">
      <aside className="relative flex w-78 flex-none flex-col overflow-hidden bg-brand px-8 pt-10 pb-8 text-[#c7d6ce] max-desktop:w-64 max-desktop:px-6 max-tablet:w-full max-tablet:flex-row max-tablet:items-center max-tablet:gap-4 max-tablet:px-4 max-tablet:py-3.5">
        {/* 지형 등고선처럼 겹친 원: 나루(나루터) 물결을 옅게 깐다. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -left-30 size-[460px] rounded-full opacity-[0.07] max-tablet:hidden"
          style={{
            background:
              'repeating-radial-gradient(circle at center, #d4efae 0 1px, transparent 1px 22px)',
          }}
        />
        <img
          className="relative h-auto w-[104px] max-tablet:w-[76px]"
          src="/brand/naru-wordmark.png?v=20261017c"
          alt="Naru"
        />
        <p className="relative mt-9 font-display text-[26px] leading-[1.25] text-[#eef8e4] max-desktop:text-[22px] max-tablet:hidden">
          {t('컨테이너 작업 환경을 준비합니다')}
        </p>
        <ol
          className="relative mt-10 flex flex-col gap-1 max-tablet:hidden"
          aria-label={t('설정 단계')}
        >
          {STEPS.map(([id, label], i) => (
            <li
              key={id}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-3.5 rounded-[9px] px-3 py-2.75 text-[13px]',
                i === step && 'bg-[#ffffff12] font-semibold text-[#f2ffe4]',
                i > step && 'text-[#8fa69a]',
              )}
            >
              <span
                className={cn(
                  'grid size-6.5 flex-none place-items-center rounded-full border font-display text-[12px]',
                  i < step && 'border-lime bg-lime text-brand',
                  i === step && 'border-lime text-lime',
                  i > step && 'border-[#ffffff2e]',
                )}
              >
                {i < step ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : i + 1}
              </span>
              {t(label)}
            </li>
          ))}
        </ol>
        <p className="relative ml-auto hidden font-display text-[13px] text-[#dfeedd] max-tablet:block">
          {step + 1} / {STEPS.length}&nbsp;&nbsp;{t(STEPS[step][1])}
        </p>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="mx-auto w-full max-w-[740px] px-10 pt-14 pb-10 max-tablet:px-4 max-tablet:pt-7">
            <h1
              ref={heading}
              tabIndex={-1}
              className="font-display text-[30px] leading-[1.2] text-ink outline-none max-tablet:text-[24px]"
            >
              {
                {
                  welcome: t('Naru에 오신 것을 환영합니다'),
                  check: t('이 PC에서 엔진을 실행할 수 있는지 확인합니다'),
                  storage: t('데이터 위치와 화면 포트를 정합니다'),
                  engine: t('사용할 엔진을 고릅니다'),
                  install: t('엔진을 설치하고 시작합니다'),
                }[key]
              }
            </h1>
            <p className="mt-3 max-w-[600px] text-[13px] leading-[1.75] text-[#5f6e63]">
              {
                {
                  welcome: t(
                    'WSL 2 위에 Naru 전용 엔진을 설치하고 Docker, Compose와 Kubernetes를 Windows에서 바로 쓰도록 연결합니다',
                  ),
                  check: t('WSL 2와 하드웨어 가상화가 필요합니다'),
                  storage: t('컨테이너 이미지와 볼륨이 이 폴더의 가상 디스크에 저장됩니다'),
                  engine: t('설정 화면에서 언제든 바꿀 수 있습니다'),
                  install: t('공식 배포물을 내려받아 검증한 뒤 설치합니다'),
                }[key]
              }
            </p>

            <div className="mt-9">
              {key === 'welcome' && (
                <div
                  role="radiogroup"
                  aria-label={t('화면 언어')}
                  className="flex gap-3.5 max-tablet:flex-col"
                >
                  {languages.map(([code, name]) => (
                    <Choice
                      key={code}
                      selected={locale === code}
                      onSelect={() => setLanguage(code)}
                      title={name}
                    >
                      {code === 'ko'
                        ? '화면과 안내를 한국어로 표시합니다'
                        : 'Show screens and guidance in English'}
                    </Choice>
                  ))}
                </div>
              )}

              {key === 'check' && (
                <div className={cn(tw.panel, 'px-6 max-tablet:px-4')}>
                  {!s && !status.error ? (
                    <ul>
                      <CheckRow state="busy" title={t('시스템을 확인하는 중')}>
                        {t('WSL, 가상화와 디스크 공간을 살펴봅니다')}
                      </CheckRow>
                    </ul>
                  ) : status.error ? (
                    <ul>
                      <CheckRow state="error" title={t('확인하지 못했습니다')}>
                        {status.error.message}
                      </CheckRow>
                    </ul>
                  ) : (
                    <ul>
                      <CheckRow
                        state={s.wsl.installed ? 'ok' : 'error'}
                        title="WSL 2"
                        action={
                          !s.wsl.installed && (
                            <Button
                              primary
                              compact
                              icon={ShieldCheck}
                              disabled={working}
                              onClick={installWsl}
                            >
                              {t('WSL 설치')}
                            </Button>
                          )
                        }
                      >
                        {s.wsl.installed
                          ? t('설치됨, 버전 {0}', [s.wsl.version || '-'])
                          : t('설치가 필요하며, 관리자 승인 뒤 설치하고 PC를 다시 시작해야 합니다')}
                      </CheckRow>
                      {/* WSL 설치 전에는 하이퍼바이저가 꺼져 있어 펌웨어 설정만 판정할 수 있다. */}
                      <CheckRow
                        state={
                          virt.ready
                            ? 'ok'
                            : virt.state === 'restart'
                              ? 'warn'
                              : blocked
                                ? 'error'
                                : 'wait'
                        }
                        title={t('하드웨어 가상화')}
                        action={
                          virt.state === 'platform' &&
                          s.wsl.installed && (
                            <Button
                              primary
                              compact
                              icon={ShieldCheck}
                              disabled={working}
                              onClick={installWsl}
                            >
                              {t('가상 머신 플랫폼 켜기')}
                            </Button>
                          )
                        }
                      >
                        {virt.ready
                          ? t('사용할 수 있습니다')
                          : virt.state === 'restart'
                            ? t('PC를 다시 시작하면 Windows 하이퍼바이저가 켜지고 그 뒤 이어서 확인합니다')
                            : virt.state === 'firmware'
                              ? virt.vm
                                ? t('{0} 가상 머신 설정에서 중첩 가상화(VT-x, AMD-V)를 켠 뒤 다시 확인해 주세요', [virt.vm])
                                : t('BIOS 또는 UEFI 설정에서 가상화(Intel VT-x, AMD-V)를 켠 뒤 다시 확인해 주세요')
                              : !s.wsl.installed
                                ? t('WSL을 설치한 뒤 확인합니다')
                                : virt.vm === 'VirtualBox'
                                  ? t('VirtualBox 가상 머신에서는 Windows 하이퍼바이저가 시작되지 않아 WSL 2를 쓸 수 없으니 Hyper-V나 VMware 가상 머신에서 중첩 가상화를 켜고 설치해 주세요')
                                  : virt.vm
                                    ? t('{0} 가상 머신 안에서 Windows 하이퍼바이저가 시작되지 않았으니 중첩 가상화를 켜고 가상 머신 플랫폼을 켠 뒤 PC를 다시 시작해 주세요', [virt.vm])
                                    : t('Windows 하이퍼바이저가 꺼져 있으니 가상 머신 플랫폼을 켠 뒤 PC를 다시 시작해 주세요')}
                      </CheckRow>
                      <CheckRow
                        state={s.freeBytes == null || s.freeBytes >= MIN_FREE ? 'ok' : 'warn'}
                        title={t('디스크 여유 공간')}
                      >
                        {s.freeBytes == null
                          ? t('여유 공간을 확인하지 못했습니다')
                          : s.freeBytes >= MIN_FREE
                            ? t('{0} 사용 가능', [bytes(s.freeBytes)])
                            : t('{0}만 남아 있어 20GB 이상 확보를 권장합니다', [
                                bytes(s.freeBytes),
                              ])}
                      </CheckRow>
                      {s.runtimeInstalled && (
                        <CheckRow state="ok" title={t('기존 Naru 런타임')}>
                          {t('이미 설치된 런타임과 데이터를 그대로 사용합니다')}
                        </CheckRow>
                      )}
                    </ul>
                  )}
                </div>
              )}

              {key === 'storage' && s && (
                <div className="flex flex-col gap-5">
                  <label className={tw.field}>
                    <span>{t('데이터 폴더')}</span>
                    <div className="flex gap-2.25">
                      <input
                        value={plan.dataDir}
                        disabled={s.dataDirLocked}
                        spellCheck={false}
                        onChange={(e) => set({ dataDir: e.target.value })}
                      />
                      <Button
                        type="button"
                        icon={HardDrive}
                        disabled={s.dataDirLocked || plan.dataDir === s.defaultDataDir}
                        onClick={() => set({ dataDir: s.defaultDataDir })}
                      >
                        {t('기본 위치')}
                      </Button>
                    </div>
                    <small className="text-muted">
                      {s.dataDirLocked
                        ? t('런타임이 이미 설치되어 있어 위치를 옮길 수 없습니다')
                        : t('여유 공간이 넉넉한 드라이브를 고르면 좋습니다')}
                    </small>
                  </label>
                  <label className={tw.field}>
                    <span>{t('Naru 화면 포트')}</span>
                    <div className="flex gap-2.25">
                      <input
                        className="max-w-[180px]"
                        inputMode="numeric"
                        value={plan.port}
                        onChange={(e) =>
                          set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })
                        }
                      />
                      <Button
                        type="button"
                        disabled={plan.port === String(s.defaultPort)}
                        onClick={() => set({ port: String(s.defaultPort) })}
                      >
                        {t('기본 포트')}
                      </Button>
                    </div>
                    <small className="text-muted">
                      {t(
                        '화면은 127.0.0.1:{0}에서 열리고, 확장 화면은 다음 번호 {1}을 함께 씁니다',
                        [plan.port || '-', plan.port ? Number(plan.port) + 1 : '-'],
                      )}
                    </small>
                  </label>
                  <label className={cn(tw.checkbox, !s.packaged && 'opacity-60')}>
                    <input
                      type="checkbox"
                      checked={s.packaged && plan.launchAtLogin}
                      disabled={!s.packaged}
                      onChange={(e) => set({ launchAtLogin: e.target.checked })}
                    />
                    <span>
                      {t('Windows에 로그인하면 창 없이 알림 영역(트레이)에서 Naru 시작')}
                      {!s.packaged && (
                        <small className="ml-2 text-[11px] text-muted">
                          {t('설치된 앱에서 설정할 수 있습니다')}
                        </small>
                      )}
                    </span>
                  </label>
                </div>
              )}

              {key === 'engine' && (
                <div className="flex flex-col gap-7">
                  <div
                    role="radiogroup"
                    aria-label={t('컨테이너 엔진')}
                    className="flex gap-3.5 max-tablet:flex-col"
                  >
                    <Choice
                      selected={plan.engine === 'moby'}
                      onSelect={() => set({ engine: 'moby' })}
                      title="Moby (Docker)"
                    >
                      {t('Docker CLI와 Compose를 그대로 쓰는 일반적인 선택')}
                    </Choice>
                    <Choice
                      selected={plan.engine === 'containerd'}
                      onSelect={() => set({ engine: 'containerd' })}
                      title="containerd"
                    >
                      {t('nerdctl과 Kubernetes 중심의 개발 환경')}
                    </Choice>
                  </div>
                  <div className={cn(tw.panel, 'px-5 py-2')}>
                    <label className={tw.checkbox}>
                      <input
                        type="checkbox"
                        checked={plan.kubernetes}
                        onChange={(e) => set({ kubernetes: e.target.checked })}
                      />
                      {t('Kubernetes(k3s)도 함께 시작')}
                    </label>
                    <label className={tw.checkbox}>
                      <input
                        type="checkbox"
                        checked={plan.installCli}
                        onChange={(e) => set({ installCli: e.target.checked })}
                      />
                      {t('Windows용 docker, kubectl, helm 명령 설치')}
                    </label>
                  </div>
                  <details className="group rounded-[11px] border border-line bg-paper px-5 py-4">
                    <summary className="cursor-pointer text-[13px] font-semibold text-ink">
                      {t('프록시 사용 (선택)')}
                    </summary>
                    <div className="mt-4">
                      <div className={cn(tw.formRow, '[&>label]:my-0')}>
                        <label className={tw.field}>
                          <span>HTTP_PROXY</span>
                          <input
                            value={plan.http}
                            placeholder="http://proxy.example.com:8080"
                            onChange={(e) => set({ http: e.target.value })}
                          />
                        </label>
                        <label className={tw.field}>
                          <span>HTTPS_PROXY</span>
                          <input
                            value={plan.https}
                            onChange={(e) => set({ https: e.target.value })}
                          />
                        </label>
                      </div>
                      <label className={tw.field}>
                        <span>NO_PROXY</span>
                        <input
                          value={plan.noProxy}
                          onChange={(e) => set({ noProxy: e.target.value })}
                        />
                        <small className="text-muted">
                          {t(
                            'Windows의 localhost 프록시는 컨테이너에서 host.docker.internal로 연결됩니다',
                          )}
                        </small>
                      </label>
                    </div>
                  </details>
                </div>
              )}

              {key === 'install' && s && (
                <Install
                  plan={plan}
                  status={s}
                  onDone={onDone}
                  onBack={() => setStep(3)}
                  onQuit={quitApp}
                />
              )}
            </div>

            {notice && (
              <p
                role="status"
                className="mt-6 rounded-[9px] border border-[#ecdcb8] bg-[#fdf8ec] px-4.5 py-3.5 text-[12px] leading-[1.7] text-[#6d5420]"
              >
                {notice}
              </p>
            )}
          </section>
        </div>

        {key !== 'install' && (
          <footer className="flex flex-none flex-wrap items-center gap-2.25 border-t border-line bg-paper px-10 py-4 max-tablet:px-4">
            {key === 'check' && (
              <Button
                icon={RefreshCw}
                disabled={status.isFetching || working}
                onClick={() => status.refetch()}
              >
                {t('다시 확인')}
              </Button>
            )}
            <div className="ml-auto flex flex-wrap justify-end gap-2.25">
              {key === 'check' && blocked && (
                <Button icon={Power} onClick={quitApp}>
                  {t('Naru 종료')}
                </Button>
              )}
              {step > 0 && (
                <Button icon={ArrowLeft} disabled={working} onClick={() => setStep((n) => n - 1)}>
                  {t('이전')}
                </Button>
              )}
              <Button primary disabled={!canNext || working} onClick={next}>
                {key === 'engine' ? t('설치 시작') : t('다음')}
                <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </footer>
        )}
      </main>
    </div>
  );
}

// 설치 단계: 필요한 작업만 차례로 실행하고, 실패한 작업부터 다시 시도한다.
function Install({ plan, status, onDone, onBack, onQuit }) {
  useLocale();
  // 내려받기 전에 필요한 서버에 닿는지 확인한다. 실패하면 설치를 시작하지 않고 원인을 보여 준다.
  const [unreachable, setUnreachable] = useState(null);
  const tasks = [
    !status.runtimeInstalled && ['installRuntime', t('Naru 런타임 설치')],
    ['startRuntime', t('엔진 시작')],
    plan.kubernetes && ['startKubernetes', t('Kubernetes 시작')],
    plan.installCli && ['installCLI', t('Windows 명령 설치')],
  ].filter(Boolean);
  const [progress, setProgress] = useState({ index: 0, failed: null, log: '' });
  const [finishing, setFinishing] = useState(false);
  const started = useRef(false);
  const logRef = useRef(null);
  const done = progress.index >= tasks.length;

  async function run(from) {
    setProgress({ index: from, failed: null, log: '' });
    setUnreachable(null);
    try {
      if (from === 0) {
        const proxy = {
          http: plan.http.trim(),
          https: plan.https.trim(),
          noProxy: plan.noProxy.trim(),
        };
        const network = await api('/onboarding/network', {
          method: 'POST',
          body: { proxy, installCli: plan.installCli, kubernetes: plan.kubernetes },
        });
        if (!network.ok) {
          setUnreachable(network.results.filter((r) => !r.ok));
          return;
        }
        const current = await api('/settings');
        await api('/settings', {
          method: 'PUT',
          body: {
            ...current,
            engine: plan.engine,
            autoStart: true,
            kubernetes: { ...current.kubernetes, enabled: plan.kubernetes },
            proxy,
          },
        });
      }
      for (let i = from; i < tasks.length; i++) {
        setProgress((p) => ({ ...p, index: i, log: '' }));
        await runJob(tasks[i][0], {}, (log) => setProgress((p) => ({ ...p, log })));
      }
      setProgress((p) => ({ ...p, index: tasks.length }));
    } catch (e) {
      setProgress((p) => ({ ...p, failed: e.message }));
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run(0);
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress.log]);

  if (unreachable)
    return (
      <div className="flex flex-col gap-5">
        <div role="alert" className={cn(tw.panel, 'px-6 max-tablet:px-4')}>
          <ul>
            {unreachable.map((r) => (
              <CheckRow
                key={r.name}
                state="error"
                title={t('{0} 서버에 연결할 수 없습니다', [r.name])}
              >
                {r.detail}
              </CheckRow>
            ))}
          </ul>
        </div>
        <p className="text-[12px] leading-[1.7] text-[#5f6e63]">
          {t(
            '설치에 필요한 파일을 내려받을 수 없어 설치를 시작하지 않았습니다. 인터넷 연결을 확인하고, 회사 네트워크라면 프록시 주소를 입력해 주세요',
          )}
        </p>
        <div className="flex flex-wrap justify-end gap-2.25">
          <Button icon={Power} onClick={onQuit}>
            {t('Naru 종료')}
          </Button>
          <Button icon={ArrowLeft} onClick={onBack}>
            {t('프록시 설정으로 돌아가기')}
          </Button>
          <Button primary icon={RefreshCw} onClick={() => run(0)}>
            {t('다시 확인')}
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      <ol className={cn(tw.panel, 'px-6 max-tablet:px-4')}>
        {tasks.map(([id, label], i) => (
          <CheckRow
            key={id}
            title={label}
            state={
              i < progress.index
                ? 'ok'
                : i > progress.index
                  ? 'wait'
                  : progress.failed
                    ? 'error'
                    : done
                      ? 'ok'
                      : 'busy'
            }
          >
            {i < progress.index || done
              ? t('완료')
              : i === progress.index
                ? progress.failed || t('진행 중')
                : t('대기')}
          </CheckRow>
        ))}
      </ol>
      {!done && (
        <pre
          ref={logRef}
          className={cn(tw.terminal, 'max-h-[260px] min-h-[180px]')}
          aria-live="polite"
        >
          {progress.log || t('작업을 준비하는 중')}
        </pre>
      )}
      <div className="flex flex-wrap justify-end gap-2.25">
        {progress.failed && (
          <>
            <Button icon={Power} onClick={onQuit}>
              {t('Naru 종료')}
            </Button>
            <Button icon={RefreshCw} onClick={() => run(progress.index)}>
              {t('이 단계부터 다시 시도')}
            </Button>
          </>
        )}
        {done && (
          <Button
            primary
            disabled={finishing}
            onClick={async () => {
              setFinishing(true);
              await api('/onboarding/complete', { method: 'POST' });
              onDone();
            }}
          >
            {t('Naru 시작')}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
