# syntax=docker/dockerfile:1
# Multi-target image: `--target api` (engine + CLI) or `--target dashboard`.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages ./packages-src
# only package.json files are needed for the install layer
RUN mkdir -p packages && for d in packages-src/*/; do n=$(basename "$d"); mkdir -p packages/$n && cp "$d/package.json" packages/$n/; done && rm -rf packages-src
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

# ---------------------------------------------------------------- engine API + CLI
FROM source AS api
RUN useradd -r -u 10001 term && mkdir -p /data && chown term /data
USER term
ENV TERM_DATA_DIR=/data TERM_API_HOST=0.0.0.0 TERM_API_PORT=8787 NODE_ENV=production
EXPOSE 8787
VOLUME ["/data"]
CMD ["pnpm", "--filter", "@term/api", "start"]

# ---------------------------------------------------------------- dashboard
FROM source AS dashboard-build
ARG NEXT_PUBLIC_API_URL=http://127.0.0.1:8787
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @term/dashboard build

FROM node:22-slim AS dashboard
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=dashboard-build /app/apps/dashboard/.next/standalone ./
COPY --from=dashboard-build /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
