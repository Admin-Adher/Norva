#!/usr/bin/env python3
"""
Phase 4 — OCR of VOBSUB (DVD `dvd_subtitle`) and DVB (`dvb_subtitle`) image subtitles → WebVTT.

Unlike PGS (clean .sup, parsed directly by ocr_pgs.py), VOBSUB lives in an MPEG-PS SPU stream and
DVB in its own packets — both fiddly to parse by hand. Instead we let ffmpeg DECODE the stream and
render it with the `sub2video` filter: it emits one video frame per subtitle event, and `showinfo`
logs each frame's PTS + checksum. So the gateway runs

    ffmpeg -i <url> -filter_complex "[0:s:<idx>]scale=W:H,showinfo[v]" -map [v] -vsync passthrough \
           -start_number 0 <dir>/f_%05d.png   2> <dir>/showinfo.log

(one ffmpeg pass, sub2video auto-inserted before scale) and hands us the frame dir. We pair each
non-blank frame with its display interval [pts[i], pts[i+1]), crop it to the text, and reuse the
exact OCR + WebVTT machinery from ocr_pgs.py — so VOBSUB and DVB share one code path.

stdin: { "dir": "<frame dir>", "lang": "eng+fra" }   stdout: WebVTT.
Exit codes: 0 ok · 2 bad request · 4 OCR error. `python3 ocr_imgsub.py --selftest` builds a fixture
(synthetic .sup → ffmpeg dvd_subtitle → sub2video frames) and round-trips it.
"""
import sys, os, json, re, glob, subprocess, tempfile

import ocr_pgs  # reuse ocr_image / to_vtt / _clean_text — the OCR + VTT assembly is format-agnostic

SHOW_RE = re.compile(r"\bn:\s*(\d+)\s.*?pts_time:([\d.]+).*?checksum:([0-9A-Fa-f]+)")
ALPHA_THRESH = 40          # luma over black; below this is background
MIN_CONTENT_PX = 12 * 12   # ignore specks (anti-alias noise on an otherwise blank frame)
MAX_CUE_S = 10.0           # cap a cue if its clear/end frame is missing (don't show one for minutes)


def fail(code, msg):
    sys.stderr.write(json.dumps({"error": msg}) + "\n")
    sys.exit(code)


def _parse_showinfo(path):
    """Ordered [{n, pts, checksum}] from an ffmpeg showinfo log."""
    frames = []
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                if "pts_time:" not in line or "checksum:" not in line:
                    continue
                m = SHOW_RE.search(line)
                if m:
                    frames.append({"n": int(m.group(1)), "pts": float(m.group(2)), "checksum": m.group(3)})
    except OSError:
        pass
    frames.sort(key=lambda x: x["n"])
    return frames


def _frame_image(path):
    """Load a sub2video RGBA frame as 'L' luma over black (same form ocr_pgs renders)."""
    from PIL import Image
    im = Image.open(path)
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (0, 0, 0, 255))
    bg.alpha_composite(im)
    return bg.convert("L")


def _content_crop(img):
    """Crop to the lit (text) region, or None if the frame is effectively blank."""
    mask = img.point(lambda p: 255 if p > ALPHA_THRESH else 0)
    bbox = mask.getbbox()
    if not bbox:
        return None
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if w * h < MIN_CONTENT_PX:
        return None
    return img.crop(bbox)


def build_cues(frame_dir):
    files = sorted(glob.glob(os.path.join(frame_dir, "f_*.png")))
    by_n = {}
    for p in files:
        m = re.search(r"f_(\d+)\.png$", p)
        if m:
            by_n[int(m.group(1))] = p
    frames = _parse_showinfo(os.path.join(frame_dir, "showinfo.log"))
    # Fallback: if showinfo is missing/empty, treat each file as a 2s slot in order.
    if not frames and by_n:
        frames = [{"n": n, "pts": i * 2.0, "checksum": str(n)} for i, n in enumerate(sorted(by_n))]
    cues = []
    i = 0
    while i < len(frames):
        fr = frames[i]
        path = by_n.get(fr["n"])
        img = _content_crop(_frame_image(path)) if path else None
        if img is None:                       # blank frame → no cue
            i += 1
            continue
        # the cue is shown until the displayed image changes (checksum differs)
        j = i + 1
        while j < len(frames) and frames[j]["checksum"] == fr["checksum"]:
            j += 1
        end = frames[j]["pts"] if j < len(frames) else fr["pts"] + 3.0
        if end <= fr["pts"] or end - fr["pts"] > MAX_CUE_S:
            end = fr["pts"] + 3.0          # missing/implausible clear → a sensible default duration
        cues.append({"start": fr["pts"], "end": end, "img": img})
        i = j
    return cues


def run(frame_dir, lang):
    if not os.path.isdir(frame_dir):
        fail(2, "frame dir not found: " + frame_dir)
    try:
        cues = build_cues(frame_dir)
    except Exception as e:
        fail(4, "frame parse error: " + str(e))
    try:
        vtt, n = ocr_pgs.to_vtt(cues, lang)
    except Exception as e:
        fail(4, "ocr error: " + str(e))
    sys.stdout.write(vtt)
    sys.stderr.write(json.dumps({"cues": len(cues), "emitted": n}) + "\n")


# ---- self test: synth .sup → ffmpeg dvd_subtitle mkv → sub2video frames → OCR ----------------
def _ffmpeg(args):
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "info", "-y", *args],
                          capture_output=True, timeout=120)


def selftest():
    cues = [(90000, 270000, "We have to leave now."),
            (360000, 585000, "- Where is the money?\n- Under the bridge.")]
    work = tempfile.mkdtemp(prefix="ocrimg-")
    sup = os.path.join(work, "t.sup")
    with open(sup, "wb") as f:
        f.write(b"".join(ocr_pgs._synth_cue_segments(a, b, t) for (a, b, t) in cues))
    mkv = os.path.join(work, "t.mkv")
    r = _ffmpeg(["-i", sup, "-c:s", "dvdsub", mkv])
    if not os.path.exists(mkv):
        print("SELFTEST SKIP — ffmpeg could not build the dvd_subtitle fixture"); print(r.stderr.decode("replace")[-400:]); sys.exit(0)
    log = os.path.join(work, "showinfo.log")
    r = _ffmpeg(["-i", mkv, "-filter_complex", "[0:s:0]scale=720:480,showinfo[v]",
                 "-map", "[v]", "-vsync", "passthrough", "-start_number", "0",
                 os.path.join(work, "f_%05d.png")])
    with open(log, "wb") as f:
        f.write(r.stderr)
    vtt, n = ocr_pgs.to_vtt(build_cues(work), "eng")
    print("--- emitted %d cues ---" % n)
    print(vtt)
    ok = ("leave now" in vtt) and ("money" in vtt) and ("bridge" in vtt)
    print("SELFTEST", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def main():
    if "--selftest" in sys.argv:
        selftest(); return
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        fail(2, "invalid json: " + str(e))
    frame_dir = req.get("dir") or ""
    lang = req.get("lang") or ocr_pgs.TESS_LANG
    if not re.match(r"^[a-z+]{3,40}$", lang):
        lang = ocr_pgs.TESS_LANG
    if not frame_dir:
        fail(2, "missing frame dir")
    run(frame_dir, lang)


if __name__ == "__main__":
    main()
