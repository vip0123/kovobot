#!/bin/sh
# Starts the virtual display, the desktop and the VNC server, then hands over to the
# Computer agent. Nothing listens outside the Computer except the agent.
set -e

# Outbound, a Computer reaches only the public internet: not the machine it runs on, the
# Docker network, other private addresses, or mail servers on port 25. Replies to the
# Computer service's connections and DNS lookups still flow. Root sets these before the
# desktop starts, and the desktop user can't change them. Without them the Computer
# doesn't start (the Computer service grants NET_ADMIN for this).
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for nameserver in $(awk '/^nameserver/ { print $2 }' /etc/resolv.conf); do
  case "$nameserver" in *:*) continue ;; esac
  iptables -A OUTPUT -d "$nameserver" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$nameserver" -p tcp --dport 53 -j ACCEPT
done
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8; do
  iptables -A OUTPUT -d "$range" -j REJECT
done
iptables -A OUTPUT -p tcp --dport 25 -j REJECT
# Outbound limits, set by the Computer service: new connections a second (a scan or a
# flood stops there; a burst of five seconds' worth is allowed) and bandwidth.
per_second="${KOVOBOT_NEW_CONNECTIONS_PER_SECOND:-20}"
iptables -A OUTPUT -m conntrack --ctstate NEW -m hashlimit --hashlimit-name new-connections --hashlimit-above "${per_second}/second" --hashlimit-burst "$((per_second * 5))" -j REJECT
outward=$(ip route show default | awk '{ print $5; exit }')
tc qdisc add dev "$outward" root tbf rate "${KOVOBOT_OUTBOUND_MBIT:-50}mbit" burst 256kb latency 400ms
if ip6tables -L OUTPUT >/dev/null 2>&1; then
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for range in fc00::/7 fe80::/10; do ip6tables -A OUTPUT -d "$range" -j REJECT; done
  ip6tables -A OUTPUT -p tcp --dport 25 -j REJECT
  ip6tables -A OUTPUT -m conntrack --ctstate NEW -m hashlimit --hashlimit-name new-connections-6 --hashlimit-above "${per_second}/second" --hashlimit-burst "$((per_second * 5))" -j REJECT
fi

Xvfb :1 -screen 0 1280x800x24 -nolisten tcp -ac &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
# The desktop starts with a clean environment, so it never sees the agent's token, and at home.
cd /home/kovobot
runuser -u kovobot -- env -i DISPLAY=:1 HOME=/home/kovobot USER=kovobot SHELL=/bin/bash LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin dbus-launch --exit-with-session startxfce4 >/dev/null 2>&1 &
x11vnc -display :1 -localhost -rfbport 5900 -forever -shared -nopw -quiet >/dev/null 2>&1 &
exec node /opt/kovobot/agent.ts
