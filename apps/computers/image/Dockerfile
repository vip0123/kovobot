# A Linux Computer: an Xfce desktop with Firefox on a virtual display, a VNC server that
# listens only inside the Computer, and our Computer agent, which streams the live view.
# Built from apps/computers: docker build -t kovobot-computer -f image/Dockerfile .
FROM node:24-bookworm-slim
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc xfce4 xfce4-terminal dbus-x11 firefox-esr fonts-dejavu ca-certificates iptables iproute2 xdotool scrot \
  && rm -rf /var/lib/apt/lists/*
# The desktop runs as kovobot. The agent runs as root, so the desktop can't read its token.
RUN useradd --create-home --shell /bin/bash kovobot
WORKDIR /opt/kovobot
COPY agent/agent.ts image/start.sh ./
RUN chmod 755 start.sh
EXPOSE 4000
CMD ["/opt/kovobot/start.sh"]
