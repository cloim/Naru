#!/bin/sh
# Runs a command in the engine environment: the engine network namespace when naru-boot created one.
# Only the network namespace changes; mounts stay shared with dockerd, k3s and Naru calls.
# k3s subcommands such as kubectl unpack their binaries here instead of the k3s default path.
export K3S_DATA_DIR=/var/lib/naru/k3s
ns=/run/netns/naru-engine
if [ -e "$ns" ]; then exec nsenter --net="$ns" "$@"; fi
exec "$@"
