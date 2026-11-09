# The Computer service image (ADR 0001). Built from the repo root:
#   docker build -f apps/computers/Dockerfile .
# Node 24 runs the TypeScript sources directly, so nothing is built.
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/computers/package.json apps/computers/
COPY packages/config/package.json packages/config/
COPY packages/plans/package.json packages/plans/
RUN pnpm install --prod --frozen-lockfile --filter "@kovobot/computers..."
COPY apps/computers/src apps/computers/src
COPY packages/config/src packages/config/src
COPY packages/plans/src packages/plans/src
ENV NODE_ENV=production
# It runs as root: it drives Docker through the engine's socket, which only root may use.
EXPOSE 3100
CMD ["node", "apps/computers/src/main.ts"]
