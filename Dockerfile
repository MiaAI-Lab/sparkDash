# ============================================================
# sparkDash — Multi-DGX Spark Monitoring Dashboard
# Dockerfile for arm64 (DGX Spark GB10 platform)
# ============================================================

# library/node via public.ecr.aws — Docker Hub (docker.io) often resolves
# to IPv6; Sparks with no IPv6 route fail auth.docker.io with
# "network is unreachable". ECR public is the same official image, IPv4-first.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# Install build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install (retry — npm in Docker can flake with
# "Exit handler never called!" on a single long ci run)
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund \
  || (echo "npm ci failed once — retrying…" && npm cache clean --force && npm ci --no-audit --no-fund)

# Copy source and build. VITE_HISTORY_HOURS sets the frontend metrics-history
# retention window (see src/hooks/metricsStore.ts); override via
# `docker compose build --build-arg VITE_HISTORY_HOURS=4` or the env in compose.
ARG VITE_HISTORY_HOURS=8
ENV VITE_HISTORY_HOURS=${VITE_HISTORY_HOURS}
COPY . .
RUN npm run build

# Drop devDependencies so the runtime image can copy node_modules
# (avoids a second `npm ci --omit=dev`, which has been flaky in Docker:
# "Exit handler never called!")
RUN npm prune --omit=dev --no-audit --no-fund \
  || (npm install --omit=dev --no-audit --no-fund && npm prune --omit=dev --no-audit --no-fund)

# ============================================================
# Production image — lean runtime
# ============================================================
FROM ${NODE_IMAGE}

# SSH client + sshpass for remote Sparks; util-linux provides nsenter for host GPU/net
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client sshpass procps util-linux iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built frontend, pruned deps, and server
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/server ./server
COPY --from=builder /app/src/shared ./src/shared
COPY --from=builder /app/src/components/ShowcasePage/showcasePrompts.ts ./src/components/ShowcasePage/showcasePrompts.ts
COPY --from=builder /app/config ./config

# Volume for persistent sparks.json
VOLUME /app/config

# Expose dashboard port
EXPOSE 5555

# Default environment
ENV PORT=5555
ENV LLM_PORT=8888
ENV NODE_ENV=production

CMD ["node", "server/index.js"]
