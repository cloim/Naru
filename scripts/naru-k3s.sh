#!/bin/sh
set -eu
engine="$1"
port="$2"
traefik="$3"
mkdir -p /var/log/naru /run/naru
if [ -f /run/naru/k3s.pid ] && kill -0 "$(cat /run/naru/k3s.pid)" 2>/dev/null; then exit 0; fi
echo $$ > /run/naru/k3s.pid
trap 'rm -f /run/naru/k3s.pid' EXIT
set -- server --https-listen-port "$port" --data-dir /var/lib/naru/k3s --write-kubeconfig /etc/naru/kubeconfig --write-kubeconfig-mode 600 --tls-san localhost --tls-san 127.0.0.1
if [ "$engine" = 'moby' ]; then
  export DOCKER_HOST=unix:///run/naru/docker.sock
  set -- "$@" --docker
else
  set -- "$@" --container-runtime-endpoint unix:///run/naru/containerd.sock
fi
if [ "$traefik" = 'false' ]; then set -- "$@" --disable traefik; fi
exec /usr/local/bin/k3s "$@" >> /var/log/naru/kubernetes.log 2>&1
