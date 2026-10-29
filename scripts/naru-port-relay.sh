#!/bin/sh
# Naru server writes the target port on the first line, then the raw stream follows.
read -r port
case "$port" in '' | *[!0-9]*) exit 1 ;; esac
exec /usr/local/bin/naru-netns socat - TCP:127.0.0.1:"$port"
