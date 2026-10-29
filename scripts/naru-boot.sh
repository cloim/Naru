#!/bin/sh
set -eu
engine="$1"
mkdir -p /run/naru /var/log/naru /var/lib/naru /etc/naru/docker
if [ ! -f /etc/naru/docker/config.json ]; then
  (umask 077; printf '{"auths":{"https://index.docker.io/v1/":{}}}\n' > /etc/naru/docker/config.json)
fi
if [ -f /run/naru/supervisor.pid ] && kill -0 "$(cat /run/naru/supervisor.pid)" 2>/dev/null; then
  echo 'Naru supervisor already running' >&2
  exit 1
fi
echo $$ > /run/naru/supervisor.pid
cleanup() {
  for pid in ${k3s_pid:-} ${buildkit_pid:-} ${engine_pid:-}; do kill "$pid" 2>/dev/null || true; done
  wait || true
  rm -f /run/naru/supervisor.pid
}
trap cleanup EXIT
trap 'exit 0' TERM INT
ulimit -n 65536
mount --make-rshared / 2>/dev/null || true
/usr/local/bin/naru-gpu > /var/log/naru/gpu.log 2>&1 || true
if [ "$engine" = 'moby' ]; then
  ln -sf /run/naru/docker.sock /var/run/docker.sock
  # Fixed min-api-version and containerd-snapshotter so migrated data and older clients keep working.
  if [ ! -f /etc/naru/dockerd.json ]; then
    printf '{\n  "min-api-version": "1.41",\n  "features": { "containerd-snapshotter": true }\n}\n' > /etc/naru/dockerd.json
  fi
  /usr/bin/dockerd --config-file /etc/naru/dockerd.json --host unix:///run/naru/docker.sock --pidfile /run/naru/docker.pid --data-root /var/lib/naru/docker > /var/log/naru/engine.log 2>&1 &
  engine_pid=$!
elif [ "$engine" = 'containerd' ]; then
  mkdir -p /var/lib/naru/k3s/agent/etc/cni/net.d /etc/cni /etc/naru/cni/net.d
  if [ ! -e /etc/cni/net.d ]; then ln -s /var/lib/naru/k3s/agent/etc/cni/net.d /etc/cni/net.d; fi
  /usr/bin/containerd --address /run/naru/containerd.sock --root /var/lib/naru/containerd --state /run/naru/containerd > /var/log/naru/engine.log 2>&1 &
  engine_pid=$!
  /usr/local/bin/buildkitd --addr unix:///run/naru/buildkitd.sock --root /var/lib/naru/buildkit --oci-worker=false --containerd-worker=true --containerd-worker-addr /run/naru/containerd.sock > /var/log/naru/buildkit.log 2>&1 &
  buildkit_pid=$!
else
  echo 'Invalid engine' >&2
  exit 2
fi
while kill -0 "$engine_pid" 2>/dev/null; do sleep 2 & wait $! || true; done
echo 'Engine process exited; check /var/log/naru/engine.log' >&2
exit 1
