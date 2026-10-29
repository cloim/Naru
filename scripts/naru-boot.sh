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
  for pid in ${k3s_pid:-} ${buildkit_pid:-} ${relay_pid:-} ${engine_pid:-}; do kill "$pid" 2>/dev/null || true; done
  pkill -f 'naru-port-relay,nofork' 2>/dev/null || true
  wait || true
  ip netns del naru-engine 2>/dev/null || true
  ip link del naru0 2>/dev/null || true
  rm -f /run/naru/supervisor.pid /run/naru/port-relay
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
  # In NAT mode the engine gets its own network namespace, like a separate VM. wslrelay only watches
  # the WSL root namespace, so published ports stay private until Naru opens them on Windows.
  rm -f /run/naru/port-relay
  ip netns del naru-engine 2>/dev/null || true
  ip link del naru0 2>/dev/null || true
  if [ "$(wslinfo --networking-mode 2>/dev/null)" = 'nat' ]; then
    ip netns add naru-engine
    ip link add naru0 type veth peer name eth0 netns naru-engine
    ip addr add 198.19.249.1/30 dev naru0
    ip link set naru0 up
    ip -n naru-engine link set lo up
    ip -n naru-engine addr add 198.19.249.2/30 dev eth0
    ip -n naru-engine link set eth0 up
    ip -n naru-engine route add default via 198.19.249.1
    iptables -t nat -C POSTROUTING -s 198.19.249.0/30 ! -o naru0 -j MASQUERADE 2>/dev/null ||
      iptables -t nat -A POSTROUTING -s 198.19.249.0/30 ! -o naru0 -j MASQUERADE
    for dir in -i -o; do
      iptables -C FORWARD "$dir" naru0 -j ACCEPT 2>/dev/null || iptables -I FORWARD "$dir" naru0 -j ACCEPT
    done
  fi
  /usr/local/bin/naru-netns /usr/bin/dockerd --config-file /etc/naru/dockerd.json --host unix:///run/naru/docker.sock --pidfile /run/naru/docker.pid --data-root /var/lib/naru/docker > /var/log/naru/engine.log 2>&1 &
  engine_pid=$!
  if [ -e /run/netns/naru-engine ]; then
    # Port 29170 matches RELAY_PORT in server/ports.js. Only the Windows host reaches eth0 in NAT mode.
    relay_ip=$(ip -4 -o addr show eth0 | awk '{split($4, a, "/"); print a[1]}')
    (while :; do socat TCP-LISTEN:29170,bind="$relay_ip",fork,reuseaddr EXEC:/usr/local/bin/naru-port-relay,nofork; sleep 1; done) >> /var/log/naru/port-relay.log 2>&1 &
    relay_pid=$!
    echo "$relay_ip" > /run/naru/port-relay
  fi
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
