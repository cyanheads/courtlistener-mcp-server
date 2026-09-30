# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to BUILDPLATFORM, not the target platform. `bun run build` emits
# platform-independent JavaScript and only `dist/` is copied forward, so this
# stage has no reason to run under emulation — and under QEMU it does not run
# at all: Bun's JavaScriptCore aborts with a spurious MemoryExhaustion
# assertion (~21 MB peak), so a cross-arch build of this stage fails outright
# on an arm64 host. Building natively also removes emulation from the slowest
# stage of a multi-arch build.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Dependencies Stage
#
# Run Bun natively, including the security scanner and OTel installer, while
# selecting native dependencies for the runtime platform with --os/--cpu.
# Only the production node_modules tree crosses into the runtime image.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps

WORKDIR /usr/src/app

# Preserve the release-age gate and Socket scanner for production installs.
COPY package.json bun.lock bunfig.toml ./
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

ARG TARGETOS
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x64 ;; \
      arm64) echo arm64 ;; \
      *) echo "Unsupported TARGETARCH '$TARGETARCH': expected amd64 or arm64" >&2; exit 1 ;; \
    esac > .bun-cpu

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts \
      --os="$TARGETOS" --cpu="$(cat .bun-cpu)"

# Install OTel at the framework's declared peer ranges, including log exporters.
COPY scripts/install-otel.ts ./scripts/
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun scripts/install-otel.ts --os="$TARGETOS" --cpu="$(cat .bun-cpu)"; \
    fi

RUN rm -rf node_modules/@socketsecurity/bun-security-scanner


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="courtlistener-mcp-server"
LABEL org.opencontainers.image.description="Search and retrieve US court opinions, federal dockets, judge records, citation networks, and oral arguments from CourtListener's 9M+ opinion corpus via MCP."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/courtlistener-mcp-server"

# Keep the original manifest; the OTel installer changes only the deps-stage copy.
COPY package.json ./
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/courtlistener-mcp-server && chown -R bun:bun /var/log/courtlistener-mcp-server

# Writable data dirs for on-disk SQLite stores (catalog index / observations
# mirror), owned by the runtime user. Mount a volume over either in production.
RUN mkdir -p /usr/src/app/.cache /usr/src/app/.mirror \
  && chown -R bun:bun /usr/src/app/.cache /usr/src/app/.mirror

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/courtlistener-mcp-server"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
