# The Bot service image: the API, serving the web app's build on the same origin.
# Node 24 runs the TypeScript sources directly, so only the web app is built.

FROM node:24-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY . .
# Only the web app goes in the image; the landing page ships to GitHub Pages.
RUN pnpm --filter @kovobot/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
RUN pnpm install --prod --frozen-lockfile --filter "@kovobot/api..."
COPY apps/api/src apps/api/src
COPY packages/config/src packages/config/src
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
# Serving the web build makes the web app's URL default to the API's (one origin).
ENV WEB_DIST_DIR=/app/apps/web/dist
# Cloud Run sets PORT itself; this default makes a plain `docker run -p 8080:8080` work too.
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "apps/api/src/main.ts"]
