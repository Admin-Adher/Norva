FROM node:22-bookworm-slim AS fixture-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3-pil \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY services/media-lab-runner/src ./src
COPY services/media-lab-runner/scripts ./scripts
COPY services/media-lab-runner/fixtures ./fixtures
COPY services/media-gateway/src/ocr_pgs.py ./tools/ocr_pgs.py
RUN python3 scripts/generate-pgs-seed.py \
      --source /build/tools/ocr_pgs.py \
      --output /build/fixtures/seeds/bitmap-subtitle.sup \
    && MEDIA_LAB_FFMPEG_PATH=/usr/bin/ffmpeg \
       MEDIA_LAB_FFPROBE_PATH=/usr/bin/ffprobe \
       node scripts/generate-fixtures.js --execute

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG MEDIA_LAB_RUNNER_SOURCE_SHA=unversioned
LABEL norva.media-lab-runner.source-sha256=${MEDIA_LAB_RUNNER_SOURCE_SHA}

WORKDIR /app
COPY services/media-lab-runner/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=node:node services/media-lab-runner/src ./src
COPY --chown=node:node services/media-lab-runner/scripts ./scripts
COPY --chown=node:node --from=fixture-builder /build/fixtures ./fixtures
COPY --chown=node:node public/js/vendor/hls-1.5.7.min.js ./vendor/hls.min.js

ENV NODE_ENV=production \
    MEDIA_LAB_BIND_HOST=0.0.0.0 \
    MEDIA_LAB_ALLOW_REMOTE_BIND=true \
    MEDIA_LAB_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    MEDIA_LAB_HLS_JS_PATH=/app/vendor/hls.min.js \
    MEDIA_LAB_FIXTURE_ROOT=/app/fixtures/generated

USER node
EXPOSE 8093
CMD ["node", "src/server.js"]
