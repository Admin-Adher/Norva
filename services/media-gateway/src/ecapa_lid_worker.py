#!/usr/bin/env python3
"""Persistent, benchmark-only SpeechBrain ECAPA language-ID worker.

Protocol: one bounded JSON object per line on stdin, one JSON object per line on
stdout. The model is loaded and warmed exactly once. The worker never connects to
a provider, downloads a model, or writes catalogue state. It only reads PCM WAV
files below ECAPA_ALLOWED_WAV_ROOT and returns raw benchmark evidence.
"""

import json
import math
import os
from pathlib import Path
import re
import resource
import sys
import time
import wave


PROTOCOL_VERSION = 1
MODEL_DIR = Path(os.environ.get("ECAPA_MODEL_DIR", "/opt/ecapa-model")).resolve()
MODEL_REVISION = os.environ.get("ECAPA_MODEL_REVISION", "unknown")[:120]
ALLOWED_ROOT_RAW = os.environ.get("ECAPA_ALLOWED_WAV_ROOT", "")
ALLOWED_ROOT = Path(ALLOWED_ROOT_RAW).resolve() if ALLOWED_ROOT_RAW else None
THREADS = max(1, min(8, int(os.environ.get("ECAPA_THREADS", "2"))))
MAX_WAV_BYTES = max(
    4096,
    min(512 * 1024 * 1024, int(os.environ.get("ECAPA_MAX_WAV_BYTES", str(64 * 1024 * 1024)))),
)
MAX_REQUEST_BYTES = 16 * 1024
MIN_AUDIO_SECONDS = 1.0
MAX_AUDIO_SECONDS = 60.0
ID_RE = re.compile(r"^[A-Za-z0-9-]{1,128}$")
LABEL_RE = re.compile(r"^'([^']+)' => ([0-9]+)$")
CANONICAL_CODES = {"iw": "he", "jw": "jv"}


def clean_text(value, fallback):
    text = re.sub(r"\s+", " ", str(value or "")).strip()[:240]
    return text or fallback


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def error_payload(code, message):
    return {
        "code": code,
        "message": clean_text(message, "ECAPA worker failed"),
    }


def canonical_language(code):
    raw = str(code or "").strip().lower()
    return CANONICAL_CODES.get(raw, raw)


def load_labels():
    label_path = MODEL_DIR / "label_encoder.txt"
    labels = {}
    with label_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            match = LABEL_RE.match(line.strip())
            if match:
                labels[int(match.group(2))] = match.group(1)
    if len(labels) != 107 or sorted(labels) != list(range(107)):
        raise RuntimeError("model label encoder is incomplete")
    return labels


def validate_and_read_wav(raw_path):
    if ALLOWED_ROOT is None or not ALLOWED_ROOT.is_absolute() or not ALLOWED_ROOT.is_dir():
        raise ValueError("allowed WAV root is unavailable")
    if not isinstance(raw_path, str) or len(raw_path) > 4096:
        raise ValueError("WAV path is invalid")
    requested = Path(raw_path)
    if not requested.is_absolute() or requested.suffix.lower() != ".wav":
        raise ValueError("only absolute WAV paths are accepted")
    if requested.is_symlink():
        raise ValueError("symbolic-link WAV input is not accepted")

    try:
        resolved = requested.resolve(strict=True)
        resolved.relative_to(ALLOWED_ROOT.resolve(strict=True))
    except (OSError, RuntimeError, ValueError):
        raise ValueError("WAV input is outside the allowed root") from None
    if resolved.suffix.lower() != ".wav" or not resolved.is_file():
        raise ValueError("WAV input must be a regular WAV file")

    stat = resolved.stat()
    if stat.st_size < 44 or stat.st_size > MAX_WAV_BYTES:
        raise ValueError("WAV input size is outside the allowed bounds")

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(str(resolved), os.O_RDONLY | nofollow)
        with os.fdopen(descriptor, "rb") as stream:
            with wave.open(stream, "rb") as wav:
                channels = wav.getnchannels()
                sample_width = wav.getsampwidth()
                sample_rate = wav.getframerate()
                frame_count = wav.getnframes()
                compression = wav.getcomptype()
                duration = frame_count / sample_rate if sample_rate else 0
                if (
                    channels != 1
                    or sample_width != 2
                    or sample_rate != 16000
                    or compression != "NONE"
                    or duration < MIN_AUDIO_SECONDS
                    or duration > MAX_AUDIO_SECONDS
                ):
                    raise ValueError("WAV must be mono 16 kHz PCM16 with bounded duration")
                frames = wav.readframes(frame_count)
    except (OSError, EOFError, wave.Error):
        raise ValueError("WAV container is invalid") from None
    expected_bytes = frame_count * channels * sample_width
    if len(frames) != expected_bytes:
        raise ValueError("WAV payload is truncated")
    return bytearray(frames)


def rss_kb():
    # Linux ru_maxrss is KiB, which is the production runtime used by the gateway.
    return max(0.0, float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss))


def load_engine():
    started = time.perf_counter()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    import torch
    import speechbrain
    from speechbrain.inference.classifiers import EncoderClassifier

    torch.set_num_threads(THREADS)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass

    labels = load_labels()
    classifier = EncoderClassifier.from_hparams(
        source=str(MODEL_DIR),
        savedir=str(MODEL_DIR),
        run_opts={"device": "cpu"},
    )
    classifier.mods.eval()

    warmup_started = time.perf_counter()
    with torch.inference_mode():
        classifier.classify_batch(torch.zeros(1, 16000, dtype=torch.float32))
    warmup_ms = (time.perf_counter() - warmup_started) * 1000
    startup_ms = (time.perf_counter() - started) * 1000
    return {
        "torch": torch,
        "speechbrain": speechbrain,
        "classifier": classifier,
        "labels": labels,
        "startup_ms": startup_ms,
        "warmup_ms": warmup_ms,
    }


def classify(engine, raw_path):
    torch = engine["torch"]
    frames = validate_and_read_wav(raw_path)
    signal = torch.frombuffer(frames, dtype=torch.int16).to(torch.float32)
    signal = signal.div_(32768.0).unsqueeze(0)

    wall_started = time.perf_counter()
    cpu_started = time.process_time()
    with torch.inference_mode():
        out_prob, _, _, _ = engine["classifier"].classify_batch(signal)
    cpu_ms = (time.process_time() - cpu_started) * 1000
    inference_ms = (time.perf_counter() - wall_started) * 1000

    log_probabilities = out_prob.detach().to("cpu").reshape(-1)
    if log_probabilities.numel() != len(engine["labels"]):
        raise RuntimeError("model returned an unexpected class count")
    top_values, top_indexes = torch.topk(log_probabilities, k=2)
    probabilities = torch.exp(log_probabilities)
    entropy = -torch.where(
        probabilities > 0,
        probabilities * log_probabilities,
        torch.zeros_like(probabilities),
    ).sum().item()

    top = []
    for log_value, index_value in zip(top_values.tolist(), top_indexes.tolist()):
        label = engine["labels"][int(index_value)]
        raw_language, _, language_name = label.partition(":")
        raw_language = raw_language.strip().lower()
        language = canonical_language(raw_language)
        top.append(
            {
                "language": language,
                "rawLanguage": raw_language,
                "label": language_name.strip() or language,
                "probability": math.exp(float(log_value)),
                "logPosterior": float(log_value),
            }
        )

    return {
        "candidateLanguage": top[0]["language"],
        "rawLanguage": top[0]["rawLanguage"],
        "label": top[0]["label"],
        "probability": top[0]["probability"],
        "logPosterior": top[0]["logPosterior"],
        "top": top,
        "margin": float(top_values[0].item() - top_values[1].item()),
        "entropy": float(entropy),
        "metrics": {
            "inferenceMs": round(inference_ms, 3),
            "cpuMs": round(cpu_ms, 3),
            "rssKb": round(rss_kb(), 1),
        },
    }


def read_bounded_line():
    raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if not raw:
        return None
    if len(raw) > MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
        while raw and not raw.endswith(b"\n"):
            raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        return b""
    return raw


def serve(engine):
    while True:
        raw = read_bounded_line()
        if raw is None:
            return
        if not raw:
            emit(
                {
                    "type": "result",
                    "protocol": PROTOCOL_VERSION,
                    "id": None,
                    "ok": False,
                    "error": error_payload("BAD_REQUEST", "request line exceeded its bound"),
                }
            )
            continue
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            emit(
                {
                    "type": "result",
                    "protocol": PROTOCOL_VERSION,
                    "id": None,
                    "ok": False,
                    "error": error_payload("BAD_REQUEST", "request JSON is invalid"),
                }
            )
            continue

        request_id = request.get("id") if isinstance(request, dict) else None
        if (
            not isinstance(request, dict)
            or request.get("type") != "classify"
            or request.get("protocol") != PROTOCOL_VERSION
            or not isinstance(request_id, str)
            or not ID_RE.match(request_id)
        ):
            emit(
                {
                    "type": "result",
                    "protocol": PROTOCOL_VERSION,
                    "id": request_id if isinstance(request_id, str) else None,
                    "ok": False,
                    "error": error_payload("BAD_REQUEST", "request shape is invalid"),
                }
            )
            continue

        try:
            result = classify(engine, request.get("wavPath"))
            emit(
                {
                    "type": "result",
                    "protocol": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": True,
                    "result": result,
                }
            )
        except ValueError as error:
            emit(
                {
                    "type": "result",
                    "protocol": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": error_payload("INVALID_WAV", error),
                }
            )
        except Exception:
            emit(
                {
                    "type": "result",
                    "protocol": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": error_payload("INFERENCE_FAILED", "ECAPA inference failed"),
                }
            )


def main():
    try:
        engine = load_engine()
    except Exception as error:
        emit(
            {
                "type": "fatal",
                "protocol": PROTOCOL_VERSION,
                "error": error_payload(
                    "STARTUP_FAILED",
                    f"ECAPA model startup failed: {error.__class__.__name__}",
                ),
            }
        )
        return 1

    emit(
        {
            "type": "ready",
            "protocol": PROTOCOL_VERSION,
            "engine": {
                "family": "speechbrain-ecapa",
                "model": "lang-id-voxlingua107-ecapa",
                "revision": MODEL_REVISION or "unknown",
                "speechbrain": getattr(engine["speechbrain"], "__version__", "unknown"),
                "torch": getattr(engine["torch"], "__version__", "unknown"),
                "classes": len(engine["labels"]),
                "threads": THREADS,
            },
            "startup": {
                "startupMs": round(engine["startup_ms"], 3),
                "warmupMs": round(engine["warmup_ms"], 3),
            },
        }
    )
    serve(engine)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
