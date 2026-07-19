# Banc LID local à la box

Ce service compare ECAPA-TDNN/VoxLingua107 et sherpa-onnx Whisper tiny/int8 sur
le même WAV réel que le benchmark whisper.cpp. Il ne contacte aucun provider,
n’écrit jamais dans le catalogue et n’est exposé que sur `127.0.0.1:8091`.

Les modèles sont téléchargés à des révisions immuables pendant le build et
chaque fichier est vérifié par SHA-256. Le runtime fonctionne hors ligne.

```bash
cd ~/norva/ops/hetzner/lid-benchmark
umask 077
printf 'LID_BENCHMARK_WORKER_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
docker compose ps
```

Le runner `../scripts/17-run-lid-benchmark.sh` lit le token depuis ce fichier,
envoie le WAV au worker local, puis détruit immédiatement sa copie temporaire.
