#!/bin/sh
# WSL GPU support through CDI. The musl host cannot run nvidia-ctk, so the spec and hook are generated here.
set -eu
spec=/etc/cdi/naru-nvidia.yaml
self=/usr/local/bin/naru-gpu
# dockerd registers the NVIDIA --gpus driver (instead of AMD) only when nvidia-cdi-hook is on PATH at startup.
marker=/usr/local/bin/nvidia-cdi-hook
[ "${0##*/}" = nvidia-cdi-hook ] && exit 0
if [ "${1:-}" = hook ]; then
  # OCI createContainer hook: register /usr/lib/wsl/lib in the container's ld cache.
  bundle=$(sed -n 's/.*"bundle" *: *"\([^"]*\)".*/\1/p')
  root=$(sed -n 's/.*"root" *: *{[^}]*"path" *: *"\([^"]*\)".*/\1/p' "$bundle/config.json")
  case "$root" in /*) ;; *) root="$bundle/$root" ;; esac
  [ -d "$root" ] || exit 0
  mkdir -p "$root/etc/ld.so.conf.d"
  echo /usr/lib/wsl/lib > "$root/etc/ld.so.conf.d/00-naru-wsl.conf"
  for ldconfig in /sbin/ldconfig /usr/sbin/ldconfig; do
    if [ -x "$root$ldconfig" ]; then
      chroot "$root" "$ldconfig" 2>/dev/null || true
      break
    fi
  done
  exit 0
fi
if [ ! -c /dev/dxg ] || [ ! -e /usr/lib/wsl/lib/libcuda.so.1 ]; then
  rm -f "$spec"
  [ -L "$marker" ] && rm -f "$marker"
  echo 'WSL GPU not detected; CDI spec removed' >&2
  exit 0
fi
mkdir -p /etc/cdi
smi=''
if [ -e /usr/lib/wsl/lib/nvidia-smi ]; then
  smi='
    - hostPath: /usr/lib/wsl/lib/nvidia-smi
      containerPath: /usr/bin/nvidia-smi
      options: [ro, nosuid, nodev, bind]'
fi
cat > "$spec.tmp" <<EOF
cdiVersion: 0.5.0
kind: nvidia.com/gpu
devices:
  - name: all
    containerEdits:
      deviceNodes:
        - path: /dev/dxg
  - name: "0"
    containerEdits:
      deviceNodes:
        - path: /dev/dxg
containerEdits:
  mounts:
    - hostPath: /usr/lib/wsl
      containerPath: /usr/lib/wsl
      options: [ro, nosuid, nodev, rbind]$smi
  hooks:
    - hookName: createContainer
      path: $self
      args: [naru-gpu, hook]
EOF
mv "$spec.tmp" "$spec"
[ -e "$marker" ] || ln -s "$self" "$marker"
echo "WSL GPU CDI spec written to $spec" >&2
