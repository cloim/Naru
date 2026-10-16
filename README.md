# Naru

Windows에서 컨테이너 엔진을 관리하는 로컬 웹앱입니다. External Engine의 기존 Docker 엔진 공유 연결과 Naru 독립 WSL 런타임을 지원합니다. External Engine 1.24.0 설치본의 REA 분석과 공식 소스를 참고했으며, UI와 제어 서버는 별도로 구현했습니다.

## 실행

Windows 11 또는 WSL 2를 사용할 수 있는 Windows와 Node.js 24 이상이 필요합니다. 프로젝트 경로에서 `scripts/install.cmd`로 의존성을 설치하고 `scripts/check.cmd`로 빌드와 단위 시험을 실행합니다. 실행 파일은 `scripts/serve.cmd`이며 화면은 [Naru 열기](http://127.0.0.1:49170)에서 사용할 수 있습니다.

장기 작업을 화면 없이 시작하려면 PowerShell에서 다음과 같이 실행합니다. 설치와 빌드에도 같은 방식으로 해당 cmd 파일을 지정합니다.

```powershell
$naruStartup = New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{ ShowWindow = [uint16]0 } -ClientOnly
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd /d /c D:\PROJECTS\Naru\scripts\serve.cmd'
  CurrentDirectory = 'D:\PROJECTS\Naru'
  ProcessStartupInformation = $naruStartup
}
```

로그와 종료코드는 `.local`에 저장됩니다. process manager에 서비스를 등록한 환경에서는 process manager로 시작하고 종료합니다. 서버는 loopback에만 바인딩합니다.

처음 실행하면 화면에서 런타임을 설치하고 시작합니다. 공식 WSL rootfs를 다운로드하고 SHA256을 검증한 뒤 `naru` 배포판을 생성합니다. 인터넷 연결과 디스크 공간이 필요합니다. 기존 External Engine 배포판과 데이터는 별도로 유지합니다.

## 엔진 연결

설정의 **연결할 엔진**에서 Naru 독립 엔진 또는 External Engine 공유를 선택합니다. 기존 데이터를 옮길 때는 먼저 백업하고 [이관 회고](docs/reviews/261016-external-data-migration.md)의 절차와 검증 항목을 참고합니다.

독립 모드의 Windows 연결은 Naru 서버가 여는 named pipe입니다. Docker 기본 context `naru`는 `naru_engine`을 쓰고, External Engine이 실행 중이 아니면 기본 `docker_engine` pipe도 같은 엔진으로 연결하여 context를 읽지 않는 Docker SDK와 도구도 그대로 동작합니다. 설정의 **Naru 서버 시작 시 엔진도 시작**(기본 켬)으로 서버가 시작될 때 엔진과 재시작 정책이 있는 컨테이너가 함께 올라옵니다. process manager를 사용하는 환경에서는 패드의 자동 시작을 설정할 수 있습니다.

독립 모드의 pipe 연결은 External Engine처럼 컨테이너와 볼륨 생성 요청의 Windows 경로(`D:\work\app`)를 `/mnt/d/work/app`으로 바꿔 전달합니다. 그래서 Windows 터미널의 `docker run -v D:\...`와 상대 bind가 있는 `docker compose up`이 그대로 동작합니다. 다만 표준 입력을 넘긴 뒤 출력을 기다리는 `docker exec -i ... < file`과 `docker run -i`는 Windows named pipe에서 끝나지 않는 문제가 남아 있습니다. 당분간은 `docker exec ... sh -c "..."`나 WSL 안의 docker를 사용합니다.

dockerd는 `/etc/naru/dockerd.json`의 containerd snapshotter와 `min-api-version 1.41`을 사용하여 External Engine과 같은 이미지 저장소와 API 범위를 유지합니다. 컨테이너가 공개한 포트는 WSL localhost 전달로 Windows의 `127.0.0.1`에서 접속합니다. 모든 WSL 배포판이 같은 네트워크를 공유하므로 External Engine 엔진과 Naru 엔진을 동시에 실행하지 않습니다.

## Tailscale 원격 접속

기본값은 이 PC의 `127.0.0.1`에서만 접속을 허용합니다. tailnet에서 쓰려면 `tailscale serve --bg --https=<포트> http://127.0.0.1:49170`로 연결하고 `%LOCALAPPDATA%\Naru\remote.json`에 serve 주소와 허용할 tailnet 로그인을 적은 뒤 서버를 다시 시작합니다.

```json
{ "host": "<기기>.<tailnet>.ts.net:<포트>", "users": ["<tailnet 로그인>"] }
```

원격 요청은 loopback으로 들어온 serve 요청이면서 Host, Origin과 serve가 검증해 넣는 `Tailscale-User-Login`이 모두 일치할 때만 허용합니다. 확장 화면은 `*.localhost` 격리 출처를 쓰므로 이 PC에서만 열립니다.

## 사용

- 컨테이너: 생성, 시작, 정지, 재시작, 삭제, 로그, 명령 실행, 대화형 터미널과 리소스 사용량을 확인합니다. Moby와 containerd의 터미널은 실제 PTY를 사용합니다.
- 이미지와 저장소: pull, tag, push, build, TAR 내보내기와 가져오기, 볼륨과 네트워크를 관리합니다. 이미지 취약점 검사는 Trivy를 사용하며 현재 실제 취약점 DB 다운로드 시험은 남아 있습니다.
- Compose 프로젝트: 컨테이너 화면에서 Compose 라벨로 컨테이너를 프로젝트별로 묶어 접고 펼칩니다. 프로젝트 단위로 시작, 정지, 재시작, 로그와 원본 compose 파일 기준의 up, down, pull, build를 실행합니다. 프로젝트 목록은 `%LOCALAPPDATA%\Naru\projects.json`에도 기록하여 down 이후에도 다시 up할 수 있습니다. compose 파일이 없는 프로젝트는 컨테이너 시작, 정지, 재시작만 제공합니다. 새 프로젝트는 `%LOCALAPPDATA%\Naru\compose\<이름>\compose.yaml`에 저장하고 화면에서 편집합니다.
- Kubernetes: k3s 설치와 시작, 리소스 조회, 다중 YAML 적용, 삭제, Pod 로그와 포트 전달을 지원합니다. Windows API 연결은 Naru의 로컬 TCP bridge로 전달합니다.
- 설정: 엔진과 namespace, Kubernetes 버전과 포트, proxy, 화면 갱신 간격을 설정합니다. 엔진을 정상 종료한 상태에서 변경합니다.
- Windows CLI: 설정 화면에서 공식 Docker, Compose, Buildx, kubectl, Helm과 credential helper를 검증하여 설치합니다. 기존 Docker CLI의 기본 context를 선택한 모드에 맞춰 연결하며 `docker ps`, `docker compose`를 그대로 사용합니다. 별도 Naru 컨테이너 CLI는 제공하지 않습니다. Docker 자격 증명 설정은 보존하며 Naru가 설치한 Compose와 Buildx 검색 경로를 추가합니다. Docker가 PATH에 없는 환경에서는 `%LOCALAPPDATA%\Naru\bin\docker.exe`를 사용합니다. kubeconfig는 Naru 전용입니다.
- 스냅샷: 독립 배포판을 정지해 내보내고, 복원 전에 현재 배포판의 백업을 생성합니다. 복원은 현재 Naru 데이터를 교체하므로 화면의 확인 절차를 거칩니다.
- 확장: OCI 이미지의 UI와 VM 서비스를 설치할 수 있습니다. UI는 확장별 localhost origin으로 격리됩니다. 확장은 엔진, VM과 선언된 host 실행 권한을 가지므로 신뢰하는 이미지에 한해 설치합니다. 전체 Docker Desktop SDK 호환은 추가 검증 대상입니다.

## 데이터와 구조

기본 데이터 경로는 `%LOCALAPPDATA%\Naru`입니다. `NARU_DATA_DIR`로 변경할 수 있습니다. WSL 배포판 이름은 `naru`로 고정되어 있어 데이터 경로를 바꿔도 별도의 배포판 인스턴스가 생기지 않습니다. 엔진 데이터는 배포판의 `/var/lib/naru`에, 설정과 작업 기록, 확장, 다운로드 캐시와 스냅샷은 Windows 데이터 경로에 저장합니다.

`server/`는 로컬 API, WSL 런타임, 작업 프로세스와 연결 계층입니다. `src/`는 React 화면과 공용 컴포넌트입니다. 화면 스타일은 Tailwind CSS v4 유틸리티로 작성합니다. 색상, 글꼴과 브레이크포인트는 `src/tailwind.css`의 `@theme`에, 여러 화면이 함께 쓰는 클래스 묶음은 `src/tw.js`에 있습니다. 간격 단위는 4px입니다. AG Grid 내부 요소의 테마만 `src/components/DataGrid/data-grid.css`에 둡니다. 큰 표와 터미널은 필요할 때 로드합니다. Docker 연결 재사용과 짧은 목록 캐시로 반복 WSL 프로세스 생성을 줄입니다. 주요 변경 작업은 별도 WMI worker가 실행하며 기록을 저장합니다. 종료된 worker의 작업 상태와 잠금은 다음 조회 또는 제출 때 복구합니다.

## 검증과 대체 판정

통합 시험을 실행하기 전에 로컬 `evidence/` 폴더를 생성합니다. 시험 결과는 `evidence/*.json`에 기록하며 공개 저장소에는 포함하지 않습니다. 시험 코드는 `tests/`에 있습니다. 통합 시험은 Naru 배포판의 엔진과 시험용 컨테이너를 변경하며, advanced 시험에는 스냅샷 복원이 포함됩니다. 사용할 데이터가 있는 환경에서는 시험 내용을 확인하고 별도 백업 후 실행합니다.

현재 Windows의 주요 개발 흐름은 실제 실행 증거를 확보했습니다. **완전 대체 판정은 계속 검증 중입니다.** 타 WSL 배포판 통합, 기업 CA와 VPN, locked 정책과 allowlist, CLI 자동화 호환, 업그레이드와 다운그레이드 복구, macOS와 Linux 등은 구현 또는 검증이 남아 있습니다. 상세 범위는 [기능 감사](docs/specs/261015-parity-audit.md)와 [검증 회고](docs/reviews/261015-verification.md)를 참고합니다.

## 참고와 라이선스

- [External Engine 공식 소스](https://github.com/example/external-engine/tree/v1.24.0), commit `a56c23d398cdf92866dd37af8fe6215266a49b3e`
- [공식 WSL distro](https://github.com/example/base-distro/releases/tag/v0.100)
- External Engine Apache-2.0 라이선스는 [원문](docs/external-engine-LICENSE.txt)을 보관합니다. 공식 rootfs와 도구에는 각 구성 요소의 라이선스가 적용됩니다. Naru 전체 배포 패키지의 라이선스 고지와 SBOM 검증은 배포 전에 완료해야 합니다.
