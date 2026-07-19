FROM node:20-bookworm-slim

ARG TORCH_VERSION=2.6.0
ARG SPEECHBRAIN_VERSION=1.1.0
ARG HUGGINGFACE_HUB_VERSION=0.36.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
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

COPY services/lid-benchmark-worker/server.js ./server.js
COPY services/media-gateway/src/ecapa-lid.js ./engines/ecapa-lid.js
COPY services/media-gateway/src/ecapa_lid_worker.py ./engines/ecapa_lid_worker.py
COPY services/media-gateway/src/sherpa-lid-bridge.js ./engines/sherpa-lid-bridge.js
COPY services/media-gateway/src/sherpa-lid-worker.js ./engines/sherpa-lid-worker.js

ENV NODE_ENV=production
ENV PORT=8091
ENV LID_MODEL_ROOT=/opt/lid-models
ENV LID_SAMPLE_ROOT=/tmp/norva-lid-samples
ENV ECAPA_PYTHON_BIN=/opt/ecapa-venv/bin/python3
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV HF_HOME=/tmp/huggingface
ENV XDG_CACHE_HOME=/tmp/cache
ENV HOME=/tmp
ENV PYTHONDONTWRITEBYTECODE=1
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=2
ENV LD_LIBRARY_PATH=/app/node_modules/sherpa-onnx-linux-x64

USER node
EXPOSE 8091
CMD ["node", "server.js"]
