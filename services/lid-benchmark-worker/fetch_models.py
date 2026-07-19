#!/usr/bin/env python3
"""Fetch immutable LID benchmark assets and verify every byte.

This script runs only while building the benchmark image. Runtime inference is
offline, and model files are read-only.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.request import Request, urlopen


ECAPA_REVISION = "0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9"
SHERPA_REVISION = "65176e2deb88badc814a94058666cadccc29b61c"

ASSETS = (
    {
        "family": "ecapa",
        "revision": ECAPA_REVISION,
        "name": "embedding_model.ckpt",
        "sha256": "ab750d5c06d713477045fa798fab5d33e959dbc0dfe4de510a9a47844c79a19a",
        "bytes": 84_474_355,
        "url": (
            "https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa/"
            f"resolve/{ECAPA_REVISION}/embedding_model.ckpt"
        ),
    },
    {
        "family": "ecapa",
        "revision": ECAPA_REVISION,
        "name": "classifier.ckpt",
        "sha256": "a50d9024ff58d317031c9787d4c6c614d454a87a8ef32f9d36338cd3ff57adbc",
        "bytes": 762_555,
        "url": (
            "https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa/"
            f"resolve/{ECAPA_REVISION}/classifier.ckpt"
        ),
    },
    {
        "family": "ecapa",
        "revision": ECAPA_REVISION,
        "name": "normalizer.ckpt",
        "sha256": "c369e01dfa2e0d84c6b116f33c7b94f1fe28c061642086538e93cde3d97c26ef",
        "bytes": 1_063,
        "url": (
            "https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa/"
            f"resolve/{ECAPA_REVISION}/normalizer.ckpt"
        ),
    },
    {
        "family": "ecapa",
        "revision": ECAPA_REVISION,
        "name": "hyperparams.yaml",
        "sha256": "88fec9791a8416a152fb10834327e18d38e5bf7a351e9b714e08cdc4af05de6f",
        "bytes": 1_519,
        "url": (
            "https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa/"
            f"resolve/{ECAPA_REVISION}/hyperparams.yaml"
        ),
    },
    {
        "family": "ecapa",
        "revision": ECAPA_REVISION,
        "name": "label_encoder.txt",
        "sha256": "9f566d83c4f19168be4a0bf86c0c7dac7d3264a95105bcbf33a7c32b83ccc17f",
        "bytes": 2_204,
        "url": (
            "https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa/"
            f"resolve/{ECAPA_REVISION}/label_encoder.txt"
        ),
    },
    {
        "family": "ecapa",
        "revision": ECAPA_REVISION,
        "name": "config.json",
        "sha256": "a861f8fbc2e23c0fc0823b3c0fd2b3d1e839563c2d4e3f9663a1237cce62bc89",
        "bytes": 51,
        "url": (
            "https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa/"
            f"resolve/{ECAPA_REVISION}/config.json"
        ),
    },
    {
        "family": "sherpa",
        "revision": SHERPA_REVISION,
        "name": "tiny-encoder.int8.onnx",
        "sha256": "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434",
        "bytes": 12_937_772,
        "url": (
            "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/"
            f"resolve/{SHERPA_REVISION}/tiny-encoder.int8.onnx"
        ),
    },
    {
        "family": "sherpa",
        "revision": SHERPA_REVISION,
        "name": "tiny-decoder.int8.onnx",
        "sha256": "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925",
        "bytes": 89_855_401,
        "url": (
            "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/"
            f"resolve/{SHERPA_REVISION}/tiny-decoder.int8.onnx"
        ),
    },
)


def fetch(asset: dict[str, object], destination: Path) -> dict[str, object]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total = 0
    request = Request(str(asset["url"]), headers={"User-Agent": "Norva-LID-benchmark/1"})
    fd, temp_name = tempfile.mkstemp(prefix=".download-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as output, urlopen(request, timeout=120) as response:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                digest.update(chunk)
                total += len(chunk)
        actual_hash = digest.hexdigest()
        if total != int(asset["bytes"]) or actual_hash != asset["sha256"]:
            raise RuntimeError(
                f"asset verification failed for {asset['family']}/{asset['name']}"
            )
        os.chmod(temp_name, 0o444)
        os.replace(temp_name, destination)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return {
        "name": asset["name"],
        "bytes": total,
        "sha256": actual_hash,
    }


def main() -> int:
    root = Path(os.environ.get("LID_MODEL_ROOT", "/opt/lid-models")).resolve()
    if root == Path("/"):
        raise RuntimeError("refusing to use filesystem root as model directory")
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "ecapa": {"revision": ECAPA_REVISION, "files": []},
        "sherpa": {"revision": SHERPA_REVISION, "files": []},
    }
    for asset in ASSETS:
        family = str(asset["family"])
        entry = fetch(asset, root / family / str(asset["name"]))
        manifest[family]["files"].append(entry)  # type: ignore[index]
    manifest_path = root / "manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
    os.chmod(manifest_path, 0o444)
    print(json.dumps(manifest, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"model fetch failed: {error}", file=sys.stderr)
        raise
