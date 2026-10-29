#!/bin/sh
# Naru server writes the target on the first line, then the raw stream follows.
# The target is a port on 127.0.0.1, or host:port for the hosts naru-agent reports.
read -r target
case "$target" in '' | *[!]0-9.:[]*) exit 1 ;; esac
case "$target" in *:*) ;; *) target="127.0.0.1:$target" ;; esac
case "${target%:*}" in 127.0.0.1 | '[::1]' | 198.19.249.2) ;; *) exit 1 ;; esac
exec /usr/local/bin/naru-netns socat - TCP:"$target"
