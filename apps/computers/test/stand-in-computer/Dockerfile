# A stand-in Computer for the Computer service's tests: the real Computer agent next to
# a stand-in VNC server, instead of the desktop. Built from apps/computers.
FROM node:24-alpine
WORKDIR /opt/kovobot
COPY agent/agent.ts test/stand-in-computer/fake-vnc.mjs ./
CMD ["sh", "-c", "node fake-vnc.mjs & exec node agent.ts"]
