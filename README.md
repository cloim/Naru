# Naru

**English** | [한국어](README.ko.md)

Naru is a desktop app for managing containers and a local Kubernetes environment on Windows. It runs the Moby or containerd engine in a dedicated WSL 2 distribution, and the Naru window and the Windows CLI share that same environment. Docker engines on servers you reach over SSH can be managed from the same screens.

Run containers, manage Compose projects, read logs and open terminals, build images, back up volumes, diagnose networks and take snapshots, all in one place.

## Installation

### Requirements

- Windows 10 2004 (build 19041) or later, or Windows 11, x64
- Hardware virtualization enabled in BIOS or UEFI. Virtual machines need nested virtualization
- An internet connection to download runtimes and tools, and disk space for images and data (20 GB or more recommended)

### Install and first run

Run the installer (`Naru_<version>_x64-setup.exe`). It installs for the current user and does not need administrator rights.

On first run, interactive onboarding walks through these steps:

1. Choose the display language
2. Environment check: WSL 2, hardware virtualization and free disk space. If WSL is missing, Naru installs it. After the PC restarts, Naru opens again and continues
3. Choose the data location and the screen port
4. Choose whether to install the engine, Kubernetes and the Windows CLI, and set a proxy
5. Download and verify the official releases, then install and start the engine

If setup cannot continue, the screen explains what to do and lets you quit Naru. Closing the window keeps Naru running in the tray so port forwarding and the Docker pipe stay available. To exit completely, use **종료** (Quit) in the tray menu. The tray menu is shown in Korean.

### Install as a web app

While Naru is running, open its address in a browser. Use the install option in the Chrome or Edge address bar or browser menu, or use **Add to Home Screen** from the Safari share menu on iPhone or iPad. Installation is available over HTTPS or a local address (`localhost` or `127.0.0.1`). The installed web app needs a connection to the Naru server to manage containers and engines.

### Updates

**업데이트 확인** (Check for updates) in the tray menu looks for a new version on GitHub Releases. When one is available, the same menu item downloads and installs it.

## Development

| Task | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Build the screens | `npm run build` |
| Development server (no window) | `cargo run -p naru -- --serve` |
| Development app | `cargo run -p naru` |
| Tests | `cargo test -p naru-core`, `npm test` |
| Benchmarks | `python scripts/bench.py` |
| Installer (NSIS) | `npm run build:desktop` |

The backend is Rust (`crates/core`), and the Tauri shell (`src-tauri`) runs the server and the window in one process. Open the development server at [http://127.0.0.1:49170](http://127.0.0.1:49170) in a browser. The engine agent (`crates/agent`) is a static Linux binary and needs `rustup target add x86_64-unknown-linux-musl`. The installer build compiles the agent and the screens first.

## Basic workflow

**Docker and Compose development**: start the engine → pull or build an image → run a container or a Compose project → check logs and resource usage. Keep data that must survive in volumes, and check how services connect on the Networks screen.

**Kubernetes development**: start Kubernetes → apply YAML → check resource status and Pod logs → open a port forward to try it. Take a snapshot before large changes to the environment.

**Docker on a server**: add an SSH profile under **Connections**, then switch the **Engine target** at the top of the sidebar. The Containers, Images, Volumes and Networks screens then work on the selected server.

Find items with the search box and the category filters in each list, and run management actions with the icon buttons at the top right of each page. Progress and results of longer requests appear in **Job history**.

## Menus and features

| Menu | Main features |
| --- | --- |
| Containers | Create, start, stop, restart, clone, logs, files, terminal, Compose project management and locks against pruning |
| Images | Docker Hub search and pull, build, tag, push, TAR export and import, layer and vulnerability analysis |
| Volumes | Create, browse and edit files, back up and restore, prune unused volumes |
| Networks | Create, view connected containers, Ping and TCP diagnostics, prune unused networks |
| Kubernetes | Run k3s, browse resources, apply YAML, Pod logs and port forwarding |
| Snapshots | Back up and restore the Naru WSL distribution |
| Extensions | Install and run developer tools packaged as OCI images |
| Connections | Add, edit, delete and test SSH remote engine profiles |
| Job history | Job status, results and detailed logs |
| Diagnostics | WSL, server and engine status, resource graphs, underlying logs and diagnostic reports |
| Settings | Engine, Kubernetes, proxy, display, CLI and registries, and remote access |

### Containers and Compose

Containers are grouped by Compose project, and you can search by name or filter by state. On the local engine, the list shows CPU and memory use for each container and totals for each project. Select several items to run an action on all of them.

The create screen offers Nginx, Redis, PostgreSQL, MySQL, Node.js and Ubuntu templates, and you can clone the settings of an existing container. The form can read the common options of a `docker run` command, or turn what you entered into one. Environment variables can be reused from built-in presets or presets you save.

For an image that is already on the engine, Naru reads its start script before the first run and asks first for environment variables it cannot start without, such as `POSTGRES_PASSWORD` for PostgreSQL. When a container stops right after starting, its detail page explains why and offers a fix: a missing required variable, a port already in use, running out of memory, or the engine refusing to start it. If the cause is not recognized, it shows the last lines of the log.

| Detail tab | What it shows |
| --- | --- |
| General | Configuration such as image, ports, environment variables, volumes and mounts, network and restart policy, and editing it |
| Logs and resources | Log search, auto-scroll and copy, CPU, memory and network use for the last 5 minutes, high usage warnings |
| Files | Browse folders, view and edit text files, upload and download |
| Terminal | Interactive terminal inside the container |

The project window shows the services in a project and how they connect, and starts, stops or restarts them together. When the original Compose file is available, it also supports `up`, `down`, `pull`, `build` and editing the file. New Compose files are saved to `compose\<name>\compose.yaml` in the data folder. The project list is kept in `projects.json`, so a project can be run again after `down`.

Use **Lock against pruning** on a container or a project to keep it when unused resources are pruned.

A container serving HTTP can also be reached at `http://<container-name>.naru.localhost:49170`. This proxy forwards requests to the container's first published port, so publish the web service's port first.

### Windows folders and change notifications

Windows bind mount paths are converted to Linux paths for the engine. For example, `D:\work\app` is mounted as `/mnt/d/work/app`.

**Settings > Engine > Notice changes in Windows folders** (on by default) sends file change events (inotify) into containers when you save files in a bound Windows folder, so development servers reload for files edited on Windows. `node_modules` and `.git` folders are skipped.

### GPU acceleration

When an NVIDIA driver is installed on Windows, Naru generates a CDI spec for WSL GPUs (`/etc/cdi/naru-nvidia.yaml`) when the Moby engine starts. Use the GPU with `docker run --gpus all`, `--gpus 1` or `--device nvidia.com/gpu=all`, without installing the NVIDIA Container Toolkit. In Compose, set `driver: nvidia` and `capabilities: [gpu]` under `deploy.resources.reservations.devices`.

Containers get `/dev/dxg`, `/usr/lib/wsl` and `nvidia-smi`, and the WSL GPU libraries are registered in the dynamic linker cache. The result is logged to `/var/log/naru/gpu.log` in the distribution. The spec uses only fixed paths that do not depend on the driver version, so driver updates need no reconfiguration. Restart the engine once only after installing an NVIDIA driver on a PC that had none.

The Moby engine uses `crun` as the default OCI runtime for faster container starts. Run a container that has compatibility problems with `--runtime runc` to use `runc` instead.

### Images

Pull images from a registry, or build them from a Dockerfile and a Windows source folder. In the pull screen, typing an image name searches Docker Hub, and typing a colon (`:`) suggests tags. For each image you can run a container, add a tag, push to a registry, and export or import a TAR.

Layer analysis shows the size and share of each build step. Vulnerability scanning uses Trivy and needs a network connection to download the tool and its database.

### Volumes and networks

Volumes hold data that must survive replacing a container. Browse their contents and edit text files in the file explorer. The backup button on a volume row downloads a `.tar.gz`, and the restore action in the file explorer uploads an archive. Restoring overwrites existing files at the same paths, so back up what you need first.

The Networks screen shows the IP and MAC addresses of connected containers. Pick a source container and a destination to diagnose Ping or TCP port connectivity. The commands run inside the source container.

Pruning unused containers, images, volumes and networks first shows what will be removed in a confirmation dialog, and skips containers locked against pruning. To return the space freed inside the engine to the Windows disk, use **Settings > Engine > Compact disk**. Compaction stops the engine and containers and may ask for administrator approval.

### Kubernetes and port forwarding

Start local k3s on the Kubernetes screen and browse resources by kind and namespace. Pods, Deployments, Services, Nodes, Namespaces, ConfigMaps, PVCs and Events are supported, along with applying YAML, viewing and deleting resources, Pod logs and downloading the kubeconfig.

**Port forwarding** is a tab on the Kubernetes screen. It connects a Service, Pod or Deployment port to a local Windows port. For example, `127.0.0.1:8080 → svc/my-web:80` lets a local browser reach that service. Stop forwards and clear finished ones from the same tab.

### Snapshots and extensions

A snapshot exports the Naru WSL distribution while it is stopped. Taking one while it runs restarts the engine after the backup. Restoring backs up the current distribution separately and replaces it with the saved data. The source data of bind-mounted Windows folders lives outside the distribution, so back it up separately.

Extensions install from OCI images and, depending on the package, provide a UI, a VM service and Windows executables. Each extension UI is isolated on its own localhost origin. Installation asks for a `TRUST` confirmation. Extensions can run with access to the engine and the host, so install only images you trust. Extension UIs open on the PC running Naru.

### SSH remote engines

Add a profile for each server under **Connections**: a name, an SSH host alias or address, a user, a port and a private key path. Leave the user, port and key empty to use your existing SSH configuration (`~/.ssh/config`). **Test connection** checks the server's Docker version before you save.

Naru runs the server's `docker` CLI through Windows OpenSSH (`ssh.exe`). It needs:

- Key-based login that does not prompt for a password
- The server's host key in `known_hosts` (confirm it once with `ssh <host>` in a terminal)
- Docker installed on the server, and permission for the login user to run `docker`

When a server is selected as the **Engine target** in the sidebar, the Containers, Images, Volumes and Networks screens work on that server. Mounts use paths on the server. WSL settings, disk, snapshots, Kubernetes, extensions, diagnostics, settings and local file tools are available only for the local engine. Profiles are stored in `~/.config/Naru/engines.json`. Deleting a profile keeps the containers and data on the server.

### Job history, diagnostics and settings

| Situation | Where to look |
| --- | --- |
| Application errors or output | Container details > Logs and resources |
| Progress of image builds, downloads or installs | Job history > job details |
| Engine or Kubernetes start problems | Diagnostics |
| Runtime install, engine switching or CLI setup | Settings |
| Server connection errors | Connections > Test connection |

Finished jobs are kept for 30 days, up to 200 records. Older records and their logs are cleaned up automatically.

The Diagnostics screen updates CPU and memory graphs for the Naru control server, the Windows host and containers every 3 seconds, and shows the engine, build engine and Kubernetes logs. **Save diagnostic report** writes status and logs to one file. Before saving, it removes the home folder path and user name, password, token and key values, private keys, e-mail addresses, tailnet host names and the computer name.

Settings has six tabs:

| Tab | Settings |
| --- | --- |
| Engine | Moby or containerd, containerd namespace, runtime install, start and stop, engine auto-start, Windows folder change detection, start at Windows sign-in, disk usage and compaction, WSL resources (CPU, memory and memory reclaim in `.wslconfig`) |
| Kubernetes | Auto-start, k3s version, API port and Traefik Ingress |
| Proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` |
| Display | Korean or English, auto-refresh interval |
| CLI and registries | Windows CLI install, registry sign-in and sign-out |
| Remote access | Tailscale host and allowed tailnet accounts |

Stop the engine before changing the main engine, Kubernetes and proxy settings. Engine auto-start on server start and display settings can be saved while running. WSL resources change only CPU, memory and `autoMemoryReclaim` under `[wsl2]` in your `.wslconfig`, keep every other setting, and apply after WSL restarts.

## Windows CLI

**Settings > CLI and registries** installs Docker, Compose, Buildx, kubectl, Helm and the credential helper. Downloads are verified, installed to `bin` in the data folder, and that folder is added to the user PATH, so `docker`, `kubectl` and `helm` work in a new terminal. If another `docker` CLI, such as Docker Desktop's, comes first in PATH, the screen says so, and `docker context use naru` still selects the Naru engine.

The Docker context `naru` connects through the `naru_engine` named pipe. When the default `docker_engine` pipe is free, it connects to the same engine too, so SDKs and tools that use the default pipe also use Naru.

### Ports and host access

The engine runs in its own network namespace, and Naru opens the engine's published TCP and UDP ports only on Windows `localhost` (`127.0.0.1` and `::1`). Ports are not opened on LAN interfaces even with `-p 0.0.0.0:...` or a LAN IP, and access from other devices is allowed only through Tailscale, such as `tailscale serve`. Ports published by containers, ports opened by `--network host` containers, Kubernetes LoadBalancers and port forwards all open the same way, with the containerd engine as well. Open ports and their state are listed at `/api/port-forwarding`.

Containers and Pods reach services on Windows `localhost` through `host.docker.internal`, including development servers listening only on IPv6 `localhost`. `127.0.0.1` or `localhost` in proxy settings is passed to the engine, containers and builds as `host.docker.internal`. Proxy settings are also applied to the Windows Docker CLI configuration, keeping any CLI proxy you set yourself.

Registry credentials are stored in the current Windows user's credential store through the Docker credential helper. Existing Docker credential settings are kept, and the Compose and Buildx search paths are added.

## Remote access

By default, Naru is reachable only on the PC running it. With Tailscale, connect the local server with Serve, then save the Tailscale host and allowed tailnet accounts in **Settings > Remote access**. Changes apply immediately and can only be made on the PC running Naru.

```text
tailscale serve --bg --https=<port> http://127.0.0.1:<Naru screen port>
```

The server checks that a request was forwarded locally, and checks the Host, the allowed account and the request's Origin. Extension UIs use localhost origins, so open them on the PC running Naru.

## Settings, data and project layout

All settings you choose are stored in `~/.config/Naru` (`%USERPROFILE%\.config\Naru`). The data folder and screen port are chosen during onboarding and default to `%LOCALAPPDATA%\Naru` and `49170`. Settings files that earlier versions kept in the data folder are copied to the settings folder on first run. The WSL distribution is always named `naru`, so changing the data folder does not create another distribution instance.

| Location | Contents |
| --- | --- |
| `~/.config/Naru` | `app.json` (data folder, screen port, start at sign-in), `settings.json` (engine, Kubernetes, proxy, display), `engines.json` (SSH remote engine profiles and the selected target), `remote.json` (remote access) |
| Data folder | WSL disk, job history, Compose files, extensions, CLI tools, download cache and snapshots |
| `/var/lib/naru` in WSL | Engine data |
| `crates/core` | Local API, runtime control, job processes and the local and SSH connection layer |
| `crates/agent` | Agent in the engine network namespace for port forwarding, DNS, host.docker.internal and file change notifications |
| `src-tauri/` | Desktop window, tray, updates and pre-launch checks |
| `src/` | React screens and shared components |
| `scripts/` | Engine boot and network scripts, verification scripts |
| `tests/` | Unit and integration tests |
| `.local/` | Run logs and temporary files in development |

The screens use React and Tailwind CSS v4. The theme is in `src/tailwind.css`, shared styles in `src/tw.js`, and grid styles in `src/components/DataGrid/data-grid.css`. Development documents in `docs/` and run evidence in `evidence/` stay local and are not tracked by Git.

## Verification and usage notes

`scripts/check.cmd` builds the screens and runs the screen unit tests. Run the backend tests with `cargo test -p naru-core`. Integration tests are in `tests/`; create a local `evidence/` folder first to keep their results. Integration tests change the real engine and test containers, and some include a snapshot restore. On a machine with data you care about, read the tests and back up before running them.

Current limits to keep in mind:

- File upload and download in the file explorer handle text. Use archive backup and restore for whole volumes.
- Image TARs hold runnable packages. Back up database files and uploaded data from where they actually live, such as volumes.
- Trivy database downloads and full extension SDK compatibility need more verification. Corporate certificates and VPNs, integration with other WSL distributions, and recovery after version changes should be checked in each environment.
- Supported environments are Windows and WSL 2. SSH remote engines target Linux servers where the Docker CLI is available.

## Related projects

Some features, including folder change notifications in WSL, redaction in diagnostic reports and pre-start checks for containers, were informed by [Kiri](https://github.com/libracoder/kiri).

## License

Naru is released under the [Apache License 2.0](LICENSE), and the license file is included in the install folder. Tools used with the runtime images are covered by the open source licenses of each component. Third-party license notices and SBOM verification for release packages must be completed before release.
