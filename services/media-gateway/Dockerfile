# --- whisper.cpp build stage: compile a static CLI + fetch the model (Phase 2 audio-track
# language detection, fully self-hosted / no paid API). Same Debian base as runtime → ABI-safe.
FROM debian:bookworm-slim AS whisper
# `small` (~466 MB) — better accuracy than `base` for transcription/subtitles (Phase 3); ~3x slower
# (~0.3 RTF on CPU → ~30-45 min/2h film, background only). Also used by the Phase 2 LID clip.
ARG WHISPER_MODEL=small
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

# ffmpeg for remux/extraction; libgomp1 for whisper.cpp's OpenMP; python3 for Argos translation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates libgomp1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# --- Phase 3b: Argos subtitle translation (CTranslate2 + SentencePiece — deliberately NOT the full
# argostranslate package, so no torch/stanza/spacy → much lighter image). A venv + the model set for
# ARGOS_LANGS (en is always the English pivot). Placed before the app COPYs so the heavy model layer
# (~1.3 GB for the default set) caches independently of source edits. Override ARGOS_LANGS to trim.
ARG ARGOS_LANGS=fr,es,ar,de,it,pt
RUN python3 -m venv /opt/argos-venv \
    && /opt/argos-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/argos-venv/bin/pip install --no-cache-dir ctranslate2 sentencepiece
COPY scripts/fetch_argos_models.py /tmp/fetch_argos_models.py
RUN ARGOS_LANGS="${ARGOS_LANGS}" ARGOS_MODELS_DIR=/opt/argos-models \
        /opt/argos-venv/bin/python3 /tmp/fetch_argos_models.py \
    && rm -f /tmp/fetch_argos_models.py

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
# Translation (Phase 3b). Empty/missing ARGOS_MODELS_DIR disables the /translate* endpoints.
ENV ARGOS_MODELS_DIR=/opt/argos-models
ENV ARGOS_PYTHON_BIN=/opt/argos-venv/bin/python3

EXPOSE 8080

CMD ["npm", "start"]
