# Naru

Windows에서 컨테이너와 로컬 Kubernetes 환경을 관리하는 웹앱입니다. 전용 WSL 2 배포판에서 Moby 또는 containerd 엔진을 실행하고, 브라우저와 Windows CLI로 같은 환경을 사용해요.

컨테이너 실행부터 Compose 프로젝트 관리, 로그와 터미널, 이미지 빌드, 볼륨 백업, 네트워크 진단과 스냅샷까지 한곳에서 처리합니다.

## 빠른 시작

### 준비 사항

- WSL 2를 사용할 수 있는 Windows 환경
- Node.js 24 이상과 npm
- 런타임과 도구를 다운로드할 인터넷 연결, 이미지와 데이터를 저장할 디스크 공간

### 설치와 실행

프로젝트 폴더에서 아래 순서로 실행합니다.

```powershell
# 의존성 설치
.\scripts\install.cmd

# 화면 빌드와 단위 테스트
.\scripts\check.cmd

# 서버 실행
.\scripts\serve.cmd
```

브라우저에서 [Naru 열기](http://127.0.0.1:49170)로 접속해 주세요. 처음에는 **Settings > Engine**에서 런타임을 설치하고 시작합니다. 설치 과정에서 WSL rootfs의 SHA256을 검증하고 `naru` 배포판을 생성해요.

기본 화면 언어는 영어입니다. **Settings > Display > Language**에서 한국어로 바꿀 수 있어요. 언어 선택은 브라우저에 즉시 저장됩니다.

실행 로그와 종료코드는 `.local/`에 저장합니다.

| 단계 | 로그 | 종료코드 |
| --- | --- | --- |
| 의존성 설치 | `.local/install.log` | `.local/install.exit` |
| 빌드 | `.local/build.log` | `.local/build.exit` |
| 단위 테스트 | `.local/test.log` | `.local/test.exit` |
| 서버 | `.local/server.log` | `.local/server.exit` |

종료코드는 프로세스가 끝난 뒤 기록되며, `0`이면 성공입니다. 서버 실행 중에는 `server.log`에서 접속 주소와 오류를 확인해 주세요.

<details>
<summary>콘솔 창 없이 실행하기</summary>

프로젝트 폴더의 PowerShell에서 다음 명령을 실행합니다. 설치나 빌드도 같은 방식으로 실행하려면 `serve.cmd`를 `install.cmd` 또는 `check.cmd`로 바꾸면 돼요. 앞 단계의 종료코드를 확인한 뒤 다음 단계를 실행해 주세요.

```powershell
$naruRoot = (Get-Location).Path
$naruScript = Join-Path $naruRoot 'scripts\serve.cmd'
$naruStartup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{
  ShowWindow = [uint16]0
} -ClientOnly
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd.exe /d /s /c ""{0}""' -f $naruScript
  CurrentDirectory = $naruRoot
  ProcessStartupInformation = $naruStartup
}
```

프로세스 관리자로 서비스를 등록한 환경에서는 해당 관리 도구에서 시작하고 종료합니다.

</details>

## 기본 사용 흐름

**Docker와 Compose 개발**은 엔진 시작 → 이미지 가져오기 또는 빌드 → 컨테이너나 Compose 프로젝트 실행 → 로그와 리소스 확인 순으로 진행하면 돼요. 유지할 데이터는 볼륨에 저장하고, 서비스 사이의 연결은 네트워크에서 확인합니다.

**Kubernetes 개발**은 Kubernetes 시작 → YAML 적용 → 리소스 상태와 Pod 로그 확인 → 포트 전달로 접속 확인 순으로 진행합니다. 환경을 크게 변경하기 전에는 스냅샷을 만들어 두세요.

목록의 검색과 분류 필터로 대상을 찾고, 페이지 오른쪽 상단의 아이콘 버튼으로 관리 작업을 실행할 수 있어요. 시간이 걸리는 요청의 진행 상황과 결과는 **작업 기록**에서 확인합니다.

## 메뉴와 기능

| 메뉴 | 주요 기능 |
| --- | --- |
| 컨테이너 | 생성, 시작, 정지, 재시작, 복제, 로그, 파일, 터미널과 Compose 프로젝트 관리 |
| 이미지 | 가져오기, 빌드, 태그, 업로드, TAR 내보내기와 불러오기, 레이어와 취약점 분석 |
| 볼륨 | 생성, 파일 탐색과 편집, 백업과 복원, 미사용 볼륨 정리 |
| 네트워크 | 생성, 연결된 컨테이너 확인, Ping과 TCP 통신 진단, 미사용 네트워크 정리 |
| Kubernetes | k3s 실행, 리소스 조회, YAML 적용, Pod 로그와 포트 전달 |
| 스냅샷 | Naru WSL 배포판 백업과 복원 |
| 확장 | OCI 이미지 기반 개발 도구 설치와 실행 |
| 작업 기록 | 작업 상태, 결과와 상세 로그 확인 |
| 진단 | WSL, 서버와 엔진 상태 및 기반 환경 로그 확인 |
| 설정 | 엔진, Kubernetes, 프록시, 화면, CLI와 레지스트리 설정 |

### 컨테이너와 Compose

컨테이너는 이름으로 검색하거나 실행 상태별로 나누어 관리합니다. 여러 항목을 선택해 일괄 작업을 실행할 수 있어요. 생성 화면에는 Nginx, Redis, PostgreSQL, MySQL, Node.js와 Ubuntu 템플릿이 있으며, 기존 컨테이너의 설정을 복사하는 복제 기능도 제공합니다.

생성 폼은 `docker run`의 기본 옵션을 읽어 채우거나 입력값을 명령어로 변환합니다. 환경 변수는 기본 프리셋과 직접 저장한 프리셋으로 재사용할 수 있어요.

| 상세 탭 | 확인할 내용 |
| --- | --- |
| 로그 | 로그 검색, 자동 스크롤과 복사 |
| 리소스 | CPU, 메모리와 네트워크 사용량, 높은 사용량 경고 |
| 파일 | 디렉터리 탐색, 텍스트 파일 조회와 편집, 업로드와 다운로드 |
| 터미널 | 컨테이너 내부 대화형 터미널 |
| 구성 | 환경 변수, 마운트와 네트워크 등 엔진의 상세 구성 |

Compose 프로젝트는 **컨테이너** 화면에서 프로젝트별로 묶어 표시합니다. 프로젝트 관리 창에서 소속 서비스와 연결 관계를 확인하고, 함께 시작하거나 정지, 재시작할 수 있어요. 원본 Compose 파일이 있으면 `up`, `down`, `pull`, `build`와 파일 편집도 지원합니다.

새 Compose 파일은 `%LOCALAPPDATA%\Naru\compose\<이름>\compose.yaml`에 저장합니다. 프로젝트 목록은 `projects.json`에 보관하므로 `down` 이후에도 다시 실행할 수 있어요.

HTTP 서비스를 실행한 컨테이너는 `http://<컨테이너이름>.naru.localhost:49170`으로도 접속할 수 있습니다. 이 프록시는 컨테이너의 첫 번째 공개 포트로 요청을 전달하므로, 웹 서비스의 포트를 공개한 뒤 사용해 주세요.

### GPU 가속

Windows에 NVIDIA 드라이버가 설치되어 있으면 Moby 엔진을 시작할 때 WSL GPU용 CDI 스펙(`/etc/cdi/naru-nvidia.yaml`)을 자동으로 생성합니다. 별도의 NVIDIA Container Toolkit 없이 `docker run --gpus all`, `--gpus 1` 또는 `--device nvidia.com/gpu=all`로 GPU를 사용할 수 있어요. Compose에서는 `deploy.resources.reservations.devices`에 `driver: nvidia`와 `capabilities: [gpu]`를 지정합니다.

컨테이너에는 `/dev/dxg`, `/usr/lib/wsl`과 `nvidia-smi`가 연결되고 WSL GPU 라이브러리가 동적 링커 캐시에 등록됩니다. 생성 결과는 배포판의 `/var/log/naru/gpu.log`에서 확인합니다. 스펙은 드라이버 버전과 무관한 고정 경로만 사용하므로 드라이버를 업데이트해도 다시 설정할 필요가 없어요. NVIDIA 드라이버가 없던 PC에 처음 설치한 경우에만 엔진을 한 번 재시작해 주세요.

### 이미지

레지스트리에서 이미지를 가져오거나 Dockerfile과 Windows 소스 폴더로 직접 빌드합니다. 이미지별로 컨테이너 실행, 태그 추가, 레지스트리 업로드, TAR 내보내기와 불러오기를 지원해요.

레이어 분석에서는 빌드 명령별 크기와 비중을 확인할 수 있습니다. 취약점 검사는 Trivy를 사용하며, 도구와 취약점 DB를 내려받을 네트워크 연결이 필요해요.

### 볼륨과 네트워크

볼륨은 컨테이너를 교체해도 유지할 데이터를 저장하는 공간입니다. 파일 탐색기에서 내용을 확인하고 텍스트 파일을 편집할 수 있어요. 볼륨 행의 백업 버튼으로 `.tar.gz`를 내려받고, 파일 탐색기의 복원 기능으로 아카이브를 업로드합니다. 복원은 같은 경로의 기존 파일을 덮어쓰므로 필요한 데이터를 먼저 백업해 주세요.

네트워크에서는 연결된 컨테이너의 IP와 MAC 주소를 확인합니다. 출발지 컨테이너와 목적지를 지정해 Ping 또는 TCP 포트 연결을 진단할 수 있어요. 진단에 필요한 명령은 출발지 컨테이너에서 실행됩니다.

컨테이너, 이미지, 볼륨과 네트워크의 미사용 리소스 정리는 확인 창을 거쳐 실행합니다. 삭제로 확보한 엔진 내부 공간을 Windows 디스크에 반환하려면 **설정 > 엔진 > 디스크 압축**을 사용해 주세요. 압축 중에는 엔진과 컨테이너가 멈추며 관리자 권한 승인이 필요할 수 있습니다.

### Kubernetes와 포트 전달

Kubernetes 화면에서 로컬 k3s를 시작하고 리소스를 종류와 네임스페이스별로 조회합니다. Pod, Deployment, Service, Node, Namespace, ConfigMap, PVC와 Event를 지원하며, YAML 적용, 리소스 구성 조회와 삭제, Pod 로그 확인과 kubeconfig 다운로드를 제공해요.

**포트 전달**은 Kubernetes 화면 안의 탭입니다. Service, Pod 또는 Deployment의 포트를 Windows 로컬 포트로 연결합니다. 예를 들어 `127.0.0.1:8080 → svc/my-web:80`으로 지정하면 로컬 브라우저에서 해당 서비스에 접속할 수 있어요. 전달 종료와 종료된 기록 삭제도 이 탭에서 수행합니다.

### 스냅샷과 확장

스냅샷은 Naru WSL 배포판을 정지한 상태로 내보냅니다. 실행 중에 생성하면 백업이 끝난 뒤 엔진을 다시 시작해요. 복원 시에는 현재 배포판을 별도 백업하고 저장한 시점의 데이터로 교체합니다. Windows 폴더를 연결한 bind mount의 원본 데이터는 배포판 밖에 있으므로 별도로 백업해 주세요.

확장은 OCI 이미지로 설치하며, 패키지에 따라 UI, VM 서비스와 Windows 실행파일을 제공합니다. 확장별 UI는 별도의 localhost 출처로 격리해요. 설치 시 `TRUST` 확인을 거치며, 확장에는 엔진과 호스트에 접근하는 실행 권한이 있으므로 신뢰하는 이미지를 사용해 주세요. 확장 UI는 Naru를 실행 중인 PC에서 열 수 있습니다.

### 작업 기록, 진단과 설정

| 확인할 상황 | 사용할 화면 |
| --- | --- |
| 애플리케이션의 오류나 실행 출력 | 컨테이너 상세 > 로그 |
| 이미지 빌드, 다운로드나 설치의 진행 상황 | 작업 기록 > 상세 로그 |
| 엔진이나 Kubernetes의 시작 문제 | 진단 |
| 런타임 설치, 엔진 전환이나 CLI 연결 | 설정 |

완료된 작업 기록은 최근 30일 이내, 최대 200건까지 보관합니다. 보관 범위를 벗어난 기록과 관련 로그는 자동으로 정리해요.

설정은 다음 다섯 개 탭으로 구성됩니다.

| 탭 | 설정 내용 |
| --- | --- |
| 엔진 | Moby 또는 containerd 선택, containerd 네임스페이스, 런타임 설치와 시작 및 종료, 엔진 자동 시작과 디스크 압축 |
| Kubernetes | 자동 시작, k3s 버전, API 포트와 Traefik Ingress |
| 프록시 | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` |
| 화면 | 한국어와 영어, 자동 갱신 간격 |
| CLI와 레지스트리 | Windows CLI 설치, 레지스트리 로그인과 로그아웃 |

엔진, Kubernetes와 프록시의 주요 설정은 엔진을 종료한 뒤 변경해 주세요. 서버 시작 시 엔진 자동 시작과 화면 설정은 실행 중에도 저장할 수 있습니다.

## Windows CLI 연결

**설정 > CLI와 레지스트리**에서 Docker, Compose, Buildx, kubectl, Helm과 자격 증명 도우미를 설치합니다. 도구는 다운로드한 파일을 검증한 뒤 설치해요. Docker가 PATH에 없으면 `%LOCALAPPDATA%\Naru\bin\docker.exe`를 사용할 수 있습니다.

Docker context `naru`는 `naru_engine` named pipe로 연결합니다. 기본 `docker_engine` pipe도 사용 가능한 경우 같은 엔진에 연결하므로, 기본 pipe를 사용하는 SDK와 도구에서도 Naru 엔진을 사용할 수 있어요.

Windows의 bind mount 경로는 엔진에 전달할 때 Linux 경로로 변환합니다. 예를 들어 `D:\work\app`은 `/mnt/d/work/app`으로 연결해요.

### 포트와 호스트 접속

엔진은 전용 네트워크 네임스페이스에서 실행되고, Naru가 엔진의 포트를 Windows `localhost`(`127.0.0.1`과 `::1`)에 직접 엽니다. 컨테이너가 공개한 포트, `--network host` 컨테이너가 연 포트, Kubernetes LoadBalancer와 포트 전달이 모두 같은 방식으로 열려요. containerd 엔진에서도 동일합니다. 열린 포트와 상태는 `/api/port-forwarding`에서 확인할 수 있습니다.

컨테이너와 Pod에서 Windows `localhost`의 서비스에 접속할 때는 `host.docker.internal`을 사용합니다. IPv6 `localhost`에서만 대기하는 개발 서버에도 연결돼요. 프록시 설정의 `127.0.0.1`이나 `localhost` 주소는 엔진, 컨테이너와 빌드에 `host.docker.internal`로 바꿔 전달합니다. 프록시는 Windows Docker CLI 설정에도 반영하며, 사용자가 직접 지정한 CLI 프록시는 유지해요.

레지스트리 인증 정보는 Docker 자격 증명 도우미를 통해 현재 Windows 사용자의 자격 증명 저장소에 보관합니다. 기존 Docker 자격 증명 설정은 유지하고 Compose와 Buildx 검색 경로를 추가해요.

## 원격 접속

기본 접속 범위는 Naru를 실행 중인 PC입니다. Tailscale을 사용하는 환경에서는 Serve로 로컬 서버를 연결하고, `%LOCALAPPDATA%\Naru\remote.json`에 허용할 호스트와 로그인 계정을 지정해 원격 접속을 설정할 수 있어요.

```text
tailscale serve --bg --https=<포트> http://127.0.0.1:49170
```

```json
{
  "host": "<기기>.<tailnet>.ts.net:<포트>",
  "users": ["<tailnet 로그인>"]
}
```

설정을 저장한 뒤 Naru 서버를 다시 시작합니다. 서버는 로컬에서 전달된 요청인지 확인하고, Host와 허용 계정, 요청에 포함된 Origin을 검사해요. 확장 UI는 localhost 출처를 사용하므로 실행 중인 PC에서 접속해 주세요.

## 데이터와 프로젝트 구조

기본 데이터 폴더는 `%LOCALAPPDATA%\Naru`이며 `NARU_DATA_DIR` 환경 변수로 변경합니다. WSL 배포판 이름은 `naru`로 고정되어 있어, 데이터 폴더를 바꿔도 별도의 배포판 인스턴스가 생성되는 것은 아니에요.

| 위치 | 내용 |
| --- | --- |
| `%LOCALAPPDATA%\Naru` | 설정, 작업 기록, Compose 파일, 확장, 다운로드 캐시와 스냅샷 |
| WSL의 `/var/lib/naru` | 엔진 데이터 |
| `server/` | 로컬 API, 런타임 제어, 작업 프로세스와 연결 계층 |
| `src/` | React 화면과 공용 컴포넌트 |
| `scripts/` | 설치, 실행과 검증 스크립트 |
| `tests/` | 단위 테스트와 통합 테스트 |
| `.local/` | 개발 환경의 실행 로그와 임시 파일 |

화면은 React와 Tailwind CSS v4로 구성합니다. 테마는 `src/tailwind.css`, 공용 스타일은 `src/tw.js`, 그리드 스타일은 `src/components/DataGrid/data-grid.css`에서 관리해요. 개발 문서 `docs/`와 실행 증거 `evidence/`는 로컬에 보관하며 Git 추적에서 제외합니다.

## 검증과 사용 시 참고사항

`scripts/check.cmd`는 화면 빌드와 단위 테스트를 실행합니다. 통합 테스트 코드는 `tests/`에 있으며, 결과를 저장하려면 먼저 로컬 `evidence/` 폴더를 준비해 주세요. 통합 테스트는 실제 엔진과 시험용 컨테이너를 변경하며, 일부 테스트에는 스냅샷 복원이 포함됩니다. 데이터가 있는 환경에서는 테스트 내용을 확인하고 백업한 뒤 실행해 주세요.

현재 사용 시 고려할 범위는 다음과 같습니다.

- Windows named pipe에서 표준 입력을 전달하는 `docker exec -i ... < file`과 `docker run -i`는 종료 대기가 길어질 수 있어요. 파일 입력이 필요한 작업에는 WSL 내부의 Docker CLI를 사용합니다.
- 파일 탐색기의 개별 파일 업로드와 다운로드는 텍스트를 처리합니다. 볼륨 전체 데이터는 아카이브 백업과 복원을 사용해 주세요.
- 이미지 TAR는 실행 패키지를 보관합니다. DB 파일과 업로드 데이터는 볼륨 등 실제 저장 위치에서 별도로 백업해 주세요.
- Trivy 취약점 DB 다운로드와 전체 확장 SDK 호환성은 추가 검증이 필요합니다. 기업 인증서와 VPN, 다른 WSL 배포판 연동, 버전 변경 후 복구도 사용 환경별로 확인해 주세요.
- 현재 지원 환경은 Windows와 WSL 2입니다.

## 라이선스

런타임 이미지와 함께 사용하는 도구에는 각 구성 요소의 오픈소스 라이선스가 적용됩니다. 배포 패키지의 라이선스 고지와 SBOM 검증은 배포 전에 완료해야 해요.
