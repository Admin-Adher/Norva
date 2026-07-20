ARG WHISPER_MODEL=small
ARG WHISPER_CPP_COMMIT=080bbbe85230f624f0b52127f1ae1218247989f9
ARG WHISPER_MODEL_SHA256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b

FROM debian:bookworm-slim AS whisper
ARG WHISPER_MODEL
ARG WHISPER_CPP_COMMIT
ARG WHISPER_MODEL_SHA256
RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential cmake ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git init whisper.cpp \
    && cd whisper.cpp \
    && git remote add origin https://github.com/ggml-org/whisper.cpp.git \
    && git fetch --depth 1 origin "${WHISPER_CPP_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build -j --config Release --target whisper-cli \
    && sh ./models/download-ggml-model.sh "${WHISPER_MODEL}" \
    && cp "models/ggml-${WHISPER_MODEL}.bin" /opt/whisper-model.bin \
    && printf '%s  %s\n' "${WHISPER_MODEL_SHA256}" /opt/whisper-model.bin \
        | sha256sum --check --strict - \
    && printf '%s\n' "${WHISPER_MODEL}" > /opt/whisper-model-name \
    && printf '%s\n' "${WHISPER_CPP_COMMIT}" > /opt/whisper-commit \
    && sha256sum build/bin/whisper-cli | cut -d' ' -f1 > /opt/whisper-bin.sha256 \
    && sha256sum /opt/whisper-model.bin | cut -d' ' -f1 > /opt/whisper-model.sha256

FROM node:20-bookworm-slim
ARG TORCH_VERSION=2.6.0
ARG SPEECHBRAIN_VERSION=1.1.0
ARG HUGGINGFACE_HUB_VERSION=0.36.2
ARG WHISPER_MODEL
ARG WHISPER_CPP_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates libgomp1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/ecapa-venv \
    && /opt/ecapa-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/ecapa-venv/bin/pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" \
    && /opt/ecapa-venv/bin/pip install --no-cache-dir \
        "speechbrain==${SPEECHBRAIN_VERSION}" \
        "huggingface-hub==${HUGGINGFACE_HUB_VERSION}"

WORKDIR /app
COPY services/lid-benchmark-worker/package*.json ./
RUN npm ci --omit=dev

COPY services/lid-benchmark-worker/fetch_models.py /tmp/fetch_models.py
RUN LID_MODEL_ROOT=/opt/lid-models /opt/ecapa-venv/bin/python3 /tmp/fetch_models.py \
    && rm -f /tmp/fetch_models.py

COPY --from=whisper /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /opt/whisper-model.bin /opt/whisper/ggml-model.bin
COPY --from=whisper /opt/whisper-model-name /opt/whisper/model-name
COPY --from=whisper /opt/whisper-commit /opt/whisper/commit
COPY --from=whisper /opt/whisper-bin.sha256 /opt/whisper/bin.sha256
COPY --from=whisper /opt/whisper-model.sha256 /opt/whisper/model.sha256

COPY services/lid-benchmark-worker/*.js ./
COPY services/media-gateway/src/ecapa-lid.js ./engines/ecapa-lid.js
COPY services/media-gateway/src/ecapa_lid_worker.py ./engines/ecapa_lid_worker.py
COPY services/media-gateway/src/sherpa-lid-bridge.js ./engines/sherpa-lid-bridge.js
COPY services/media-gateway/src/sherpa-lid-worker.js ./engines/sherpa-lid-worker.js

ENV NODE_ENV=production
ENV PORT=8091
ENV LID_MODEL_ROOT=/opt/lid-models
ENV LID_SAMPLE_ROOT=/tmp/norva-lid-samples
ENV LID_VAD_MODEL=/opt/lid-models/vad/silero_vad.onnx
ENV ECAPA_PYTHON_BIN=/opt/ecapa-venv/bin/python3
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/opt/whisper/ggml-model.bin
ENV WHISPER_CPP_COMMIT=${WHISPER_CPP_COMMIT}
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV HF_HOME=/tmp/huggingface
ENV XDG_CACHE_HOME=/tmp/cache
ENV HOME=/tmp
ENV PYTHONDONTWRITEBYTECODE=1
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=2
ENV LD_LIBRARY_PATH=/app/node_modules/sherpa-onnx-linux-x64

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8091/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER node
EXPOSE 8091
CMD ["node", "server.js"]
