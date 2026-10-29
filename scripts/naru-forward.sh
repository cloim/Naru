#!/bin/sh
set -eu
id="$1"
namespace="$2"
resource="$3"
ports="$4"
mkdir -p /run/naru/forwards /var/log/naru
echo $$ > "/run/naru/forwards/$id.pid"
exec /usr/local/bin/naru-netns /usr/local/bin/k3s kubectl --kubeconfig /etc/naru/kubeconfig --namespace "$namespace" port-forward --address 127.0.0.1 "$resource" "$ports" >> "/var/log/naru/forward-$id.log" 2>&1
