#!/bin/sh
set -eu
for source in /var/lib/*; do
  [ -d "$source/docker" ] || [ -d "$source/containerd" ] || continue
  label=${source##*/}
  [ "$label" = naru ] && continue
  [ -f "/etc/$label/docker/config.json" ] || continue
  if [ ! -e /var/lib/naru ]; then mv "$source" /var/lib/naru; ln -s /var/lib/naru "$source"; fi
  for parent in /etc /var/log; do
    if [ -d "$parent/$label" ] && [ ! -e "$parent/naru" ]; then mv "$parent/$label" "$parent/naru"; ln -s "$parent/naru" "$parent/$label"; fi
  done
  if [ -f /etc/naru/docker/config.json ]; then sed -i "s/\"$label\"/\"naru\"/g" /etc/naru/docker/config.json; fi
  if [ -f "/usr/local/bin/docker-credential-$label" ]; then
    sed "s#/$label/#/naru/#gI" "/usr/local/bin/docker-credential-$label" > /usr/local/bin/docker-credential-naru
    chmod 755 /usr/local/bin/docker-credential-naru
  fi
  break
done
if [ -L /etc/cni/net.d ]; then ln -sfn /var/lib/naru/k3s/agent/etc/cni/net.d /etc/cni/net.d; fi
