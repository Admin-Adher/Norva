#!/usr/bin/env python3
"""Generate the deterministic bitmap-subtitle seed used by the Media Lab."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def load_pgs_module(source: Path):
    spec = importlib.util.spec_from_file_location("norva_media_lab_pgs", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("MEDIA_LAB_PGS_SOURCE_INVALID")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.source).resolve(strict=True)
    output = Path(args.output).resolve()
    module = load_pgs_module(source)
    cues = (
        (45_000, 180_000, "Norva subtitle test"),
        (202_500, 337_500, "Bitmap cue number two"),
    )
    blob = b"".join(module._synth_cue_segments(start, end, text) for start, end, text in cues)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(blob)

    parsed = module.parse_sup(str(output))
    expected_times = ((0.5, 2.0), (2.25, 3.75))
    if len(parsed) != len(expected_times):
        raise RuntimeError("MEDIA_LAB_PGS_SEED_PARSE_FAILED")
    for cue, (expected_start, expected_end) in zip(parsed, expected_times):
        if abs(cue["start"] - expected_start) > 0.01 or abs(cue["end"] - expected_end) > 0.01:
            raise RuntimeError("MEDIA_LAB_PGS_SEED_TIMING_FAILED")
        if cue["img"].width <= 0 or cue["img"].height <= 0:
            raise RuntimeError("MEDIA_LAB_PGS_SEED_BITMAP_FAILED")

    print(json.dumps({
        "protocol": 1,
        "bytes": len(blob),
        "cues": len(parsed),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
