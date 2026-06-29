# --- whisper.cpp build stage: compile a static CLI + fetch the model (Phase 2 audio-track
# language detection, fully self-hosted / no paid API). Same Debian base as runtime → ABI-safe.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_MODEL=base
RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential cmake ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git \
    && cd whisper.cpp \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build -j --config Release --target whisper-cli \
    && sh ./models/download-ggml-model.sh "${WHISPER_MODEL}" \
    && cp "models/ggml-${WHISPER_MODEL}.bin" /opt/whisper-model.bin

# --- runtime stage ---
FROM node:20-bookworm-slim

# ffmpeg for remux/extraction; libgomp1 for whisper.cpp's OpenMP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# whisper.cpp CLI (static) + model for audio-track language detection.
COPY --from=whisper /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /opt/whisper-model.bin /opt/whisper/ggml-model.bin

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV OUTPUT_DIR=/tmp/norva-media-gateway
# Language-detection (Phase 2). Unset WHISPER_BIN to disable the /detect-language endpoint.
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/opt/whisper/ggml-model.bin

EXPOSE 8080

CMD ["npm", "start"]
