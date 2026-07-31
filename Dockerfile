# Self-hosted skein: builds the web bundle, bakes it into the `skein` binary,
# and ships that binary alone.
#
# IMPORTANT — serve this over HTTPS. WebGPU and SharedArrayBuffer are only
# available in a secure context, which means TLS or localhost. Reached over
# plain HTTP at a LAN address or bare IP, the app still loads but drops to the
# WebGL2 renderer and the CPU layout fallback (REQUIREMENTS.md §8) with no
# error message. Put it behind a TLS-terminating proxy.
#
#   docker build -t skein .
#   docker run --rm -p 7373:7373 skein
#
# Include a downloadable sample graph (see bench/generate-fixtures.mjs for
# presets — tiny, small, clustered, medium):
#
#   docker build --build-arg SAMPLE_FIXTURE=small -t skein .

# Pinned to rust-toolchain.toml; keep them in step.
FROM rust:1.94.1-slim-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown \
 && curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh

WORKDIR /src

# Manifests first so the dependency install is cached independently of source
# edits. All three workspace manifests are needed for `npm ci` to resolve.
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY tests/package.json tests/package.json
RUN npm ci

COPY . .

# wasm-pack + vite. Must precede the cargo build: skein-cli's build.rs embeds
# whatever web/dist holds at compile time, and silently produces an assetless
# binary if it is missing.
RUN npm run build

ARG SAMPLE_FIXTURE=""
RUN mkdir -p bench/fixtures \
 && if [ -n "$SAMPLE_FIXTURE" ]; then node bench/generate-fixtures.mjs "$SAMPLE_FIXTURE"; fi

RUN cargo build --release -p skein

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home skein

COPY --from=builder /src/target/release/skein /usr/local/bin/skein
COPY --from=builder /src/bench/fixtures /srv/fixtures

USER skein
EXPOSE 7373

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --quiet --spider http://127.0.0.1:7373/ || exit 1

ENTRYPOINT ["skein"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7373", "--no-open", "--fixtures", "/srv/fixtures"]
