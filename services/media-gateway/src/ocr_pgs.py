#!/usr/bin/env python3
"""
Phase 4 — OCR of PGS (HDMV Presentation Graphic Stream / Blu-ray) image subtitles → WebVTT.

Invoked per job by the Node gateway: reads a JSON request on stdin
  { "sup": "<path to a .sup file>", "lang": "eng+fra" }
parses the PGS bitstream into timed bitmaps, OCRs each cue with tesseract, and writes
the resulting WEBVTT to stdout (cue timings from the stream's PTS, text from OCR).

The gateway extracts the image-sub track to a self-contained .sup first
  ffmpeg -i <url> -map 0:s:<idx> -c:s copy job.sup
so this script only deals with the well-specified PGS container — no provider I/O here.

Why parse the format directly (not ffmpeg sub2video): a Display Set carries an exact
PTS, so we get precise per-cue start/end. sub2video would rasterise at a fixed rate and
lose that. This mirrors how pgsrip / Subtitle Edit do it, in ~one self-contained file.

Rendering for OCR: each glyph is drawn as its palette luma premultiplied over a BLACK
background (value = Y * alpha / 255). That reproduces "light text on black", which
tesseract 5 reads at near-100% (validated on synthetic + low-contrast samples). The dark
outline (low luma) sinks into the black background, leaving the bright fill as clean text.

Exit codes: 0 ok · 2 bad request · 4 OCR/parse error.
Run `python3 ocr_pgs.py --selftest` to round-trip a synthetic 2-cue .sup (no provider).
"""
import sys, os, json, re, struct, subprocess, tempfile

# ---- PGS segment types -------------------------------------------------------
PDS, ODS, PCS, WDS, END = 0x14, 0x15, 0x16, 0x17, 0x80
TESS_LANG = "eng"
UPSCALE = 3            # tesseract likes larger glyphs; provider bitmaps are small
MIN_CUE_GAP = 0.05


def fail(code, msg):
    sys.stderr.write(json.dumps({"error": msg}) + "\n")
    sys.exit(code)


def _clamp8(v):
    return 0 if v < 0 else (255 if v > 255 else v)


def ycrcb_to_luma_alpha(entries):
    """Palette id -> (Y 0..255, alpha 0..255). We only need luma + alpha for OCR."""
    pal = {}
    for (pid, y, cr, cb, a) in entries:
        pal[pid] = (y, a)
    return pal


# ---- RLE (PGS run-length) ----------------------------------------------------
def decode_rle(data, width, height):
    """RLE-decoded palette indices, row-major, padded/truncated to width*height."""
    out = bytearray()
    line = bytearray()
    i, n = 0, len(data)
    while i < n:
        b = data[i]; i += 1
        if b != 0:
            line.append(b)
            continue
        if i >= n:
            break
        b2 = data[i]; i += 1
        if b2 == 0:                                   # end of line
            if len(line) < width:
                line.extend(b"\x00" * (width - len(line)))
            out.extend(line[:width]); line = bytearray()
            continue
        color = 0
        top = b2 & 0xC0
        if top == 0x00:
            run = b2 & 0x3F
        elif top == 0x40:
            run = ((b2 & 0x3F) << 8) | data[i]; i += 1
        elif top == 0x80:
            run = b2 & 0x3F; color = data[i]; i += 1
        else:                                         # 0xC0
            run = ((b2 & 0x3F) << 8) | data[i]; i += 1; color = data[i]; i += 1
        line.extend(bytes([color]) * run)
    if line:
        if len(line) < width:
            line.extend(b"\x00" * (width - len(line)))
        out.extend(line[:width])
    need = width * height
    if len(out) < need:
        out.extend(b"\x00" * (need - len(out)))
    return bytes(out[:need])


def encode_rle(indices, width, height):
    """Inverse of decode_rle — only used by --selftest to synthesise a .sup."""
    out = bytearray()
    for y in range(height):
        row = indices[y * width:(y + 1) * width]
        x = 0
        while x < width:
            c = row[x]; run = 1
            while x + run < width and row[x + run] == c and run < 16383:
                run += 1
            if c == 0:
                if run <= 63:
                    out += bytes([0, run])
                else:
                    out += bytes([0, 0x40 | (run >> 8), run & 0xFF])
            else:
                if run <= 63:
                    out += bytes([0, 0x80 | run, c])
                else:
                    out += bytes([0, 0xC0 | (run >> 8), run & 0xFF, c])
            x += run
        out += bytes([0, 0])                          # end of line
    return bytes(out)


# ---- segment parsing ---------------------------------------------------------
def _parse_pds(seg):
    entries = []
    j = 2                                             # skip palette_id, palette_version
    while j + 5 <= len(seg):
        entries.append((seg[j], seg[j + 1], seg[j + 2], seg[j + 3], seg[j + 4]))
        j += 5
    return entries


def _parse_ods(seg):
    # object_id(2) version(1) last_in_seq(1) data_len(3) width(2) height(2) rle...
    if len(seg) < 11:
        return None
    object_id = struct.unpack(">H", seg[0:2])[0]
    width = struct.unpack(">H", seg[7:9])[0]
    height = struct.unpack(">H", seg[9:11])[0]
    rle = seg[11:]
    return {"id": object_id, "w": width, "h": height, "rle": rle}


def _parse_pcs_objects(seg):
    # width(2) height(2) fps(1) comp_num(2) comp_state(1) pal_upd(1) pal_id(1) n_objs(1) objs...
    if len(seg) < 11:
        return 0, []
    n = seg[10]
    objs = []
    j = 11
    for _ in range(n):
        if j + 8 > len(seg):
            break
        object_id = struct.unpack(">H", seg[j:j + 2])[0]
        window_id = seg[j + 2]
        cropped = seg[j + 3]
        x = struct.unpack(">H", seg[j + 4:j + 6])[0]
        y = struct.unpack(">H", seg[j + 6:j + 8])[0]
        j += 8
        if cropped & 0x80:
            j += 8                                    # skip crop rectangle
        objs.append({"id": object_id, "x": x, "y": y})
    return n, objs


def parse_sup(path):
    """Walk the .sup into display sets → list of cues {start, end, img(L mode)}.

    Segments are grouped into display sets (each terminated by an END segment) and
    each set is processed as a unit, because the PCS that references the objects comes
    BEFORE its ODS/PDS in the same set. Palette + objects persist across sets so an
    epoch that defines them once and re-shows them later still resolves."""
    from PIL import Image
    with open(path, "rb") as f:
        buf = f.read()
    i, n = 0, len(buf)
    palette = {}
    objects = {}
    cues = []
    open_cue = None
    ds = []                                           # segments of the current display set
    while i + 13 <= n:
        if buf[i:i + 2] != b"PG":
            break
        pts = struct.unpack(">I", buf[i + 2:i + 6])[0]
        seg_type = buf[i + 10]
        seg_size = struct.unpack(">H", buf[i + 11:i + 13])[0]
        seg = buf[i + 13:i + 13 + seg_size]
        i += 13 + seg_size
        ds.append((seg_type, pts / 90000.0, seg))
        if seg_type != END:
            continue
        # ---- process one complete display set ----
        pcs = next((d for d in ds if d[0] == PCS), None)
        for (t, _pts, s) in ds:                       # update persistent state first
            if t == PDS:
                palette = ycrcb_to_luma_alpha(_parse_pds(s))
            elif t == ODS:
                o = _parse_ods(s)
                if o:
                    objects[o["id"]] = o
        ds = []
        if pcs is None:
            continue
        pts_s = pcs[1]
        n_objs, comp = _parse_pcs_objects(pcs[2])
        if n_objs == 0:                               # screen clear → close current cue
            if open_cue is not None:
                open_cue["end"] = pts_s
                cues.append(open_cue); open_cue = None
            continue
        if open_cue is not None:                      # new cue without an explicit clear
            open_cue["end"] = pts_s
            cues.append(open_cue)
        img = _compose(comp, objects, palette, Image)
        open_cue = {"start": pts_s, "end": None, "img": img}
    if open_cue is not None:
        cues.append(open_cue)
    return [c for c in cues if c.get("img") is not None]


def _compose(comp, objects, palette, Image):
    """Render the cue's objects as grayscale (luma premultiplied over black)."""
    imgs = []
    for co in comp:
        o = objects.get(co["id"])
        if not o or o["w"] <= 0 or o["h"] <= 0:
            continue
        idx = decode_rle(o["rle"], o["w"], o["h"])
        px = bytearray(len(idx))
        for k, pidx in enumerate(idx):
            y, a = palette.get(pidx, (0, 0))
            px[k] = (y * a) // 255
        imgs.append(Image.frombytes("L", (o["w"], o["h"]), bytes(px)))
    if not imgs:
        return None
    # MVP: stack multiple objects vertically (rare); usually one object per cue
    if len(imgs) == 1:
        return imgs[0]
    W = max(im.width for im in imgs)
    H = sum(im.height for im in imgs) + 8 * (len(imgs) - 1)
    canvas = Image.new("L", (W, H), 0)
    yoff = 0
    for im in imgs:
        canvas.paste(im, ((W - im.width) // 2, yoff)); yoff += im.height + 8
    return canvas


# ---- OCR ---------------------------------------------------------------------
def ocr_image(img, lang):
    from PIL import Image
    big = img.resize((max(1, img.width * UPSCALE), max(1, img.height * UPSCALE)), Image.LANCZOS)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        tmp = tf.name
    try:
        big.save(tmp)
        out = subprocess.run(
            ["tesseract", tmp, "stdout", "--psm", "6", "-l", lang],
            capture_output=True, timeout=30,
        )
        text = out.stdout.decode("utf-8", "replace")
    finally:
        try: os.unlink(tmp)
        except OSError: pass
    return _clean_text(text)


def _clean_text(text):
    lines = []
    for ln in text.replace("\r", "").split("\n"):
        s = ln.strip()
        if not s:
            continue
        # common OCR fixes on subtitle bitmaps: lone pipe/bar read for capital I
        s = re.sub(r"(?<=\s)\|(?=\s)", "I", s)
        s = re.sub(r"^\|(?=\s)", "I", s)
        lines.append(s)
    # de-dupe an accidentally repeated single line
    if len(lines) == 2 and lines[0] == lines[1]:
        lines = lines[:1]
    return "\n".join(lines)


def _ts(t):
    if t is None:
        t = 0.0
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return "%02d:%02d:%06.3f" % (h, m, s)


def to_vtt(cues, lang):
    out = ["WEBVTT", ""]
    k = 0
    for c in cues:
        start = c["start"]
        end = c["end"] if (c["end"] is not None and c["end"] > start) else start + 2.0
        txt = ocr_image(c["img"], lang)
        if not txt:
            continue
        k += 1
        out.append(str(k))
        out.append("%s --> %s" % (_ts(start), _ts(end)))
        out.append(txt)
        out.append("")
    return "\n".join(out), k


def run(sup_path, lang):
    if not os.path.exists(sup_path):
        fail(2, "sup not found: " + sup_path)
    try:
        cues = parse_sup(sup_path)
    except Exception as e:
        fail(4, "parse error: " + str(e))
    try:
        vtt, n = to_vtt(cues, lang)
    except Exception as e:
        fail(4, "ocr error: " + str(e))
    sys.stdout.write(vtt)
    sys.stderr.write(json.dumps({"cues": len(cues), "emitted": n}) + "\n")


# ---- self test (no provider, no real .sup needed) ----------------------------
def _seg(seg_type, pts_ticks, payload):
    return b"PG" + struct.pack(">I", pts_ticks) + struct.pack(">I", 0) + \
        bytes([seg_type]) + struct.pack(">H", len(payload)) + payload


def _synth_cue_segments(pts_ticks, end_ticks, text, canvas_w=720):
    """Rasterise `text` to a small bitmap and emit the PGS segments for one cue."""
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
    except Exception:
        font = ImageFont.load_default()
    lines = text.split("\n")
    pad = 8
    tmp = Image.new("L", (10, 10), 0)
    d = ImageDraw.Draw(tmp)
    widths, heights = [], []
    for ln in lines:
        bb = d.textbbox((0, 0), ln, font=font)
        widths.append(bb[2] - bb[0]); heights.append(bb[3] - bb[1] + 6)
    w = max(widths) + 2 * pad
    h = sum(heights) + 2 * pad
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    yoff = pad
    for i, ln in enumerate(lines):
        bb = d.textbbox((0, 0), ln, font=font)
        d.text(((w - (bb[2] - bb[0])) // 2 - bb[0], yoff), ln, fill=235, font=font)
        yoff += heights[i]
    # palette index map: 0 = transparent, 1 = opaque white
    raw = img.tobytes()
    indices = bytes(1 if b > 90 else 0 for b in raw)
    rle = encode_rle(indices, w, h)
    pal = bytes([0, 0]) + bytes([0, 16, 128, 128, 0]) + bytes([1, 235, 128, 128, 255])
    ods = struct.pack(">H", 0) + bytes([0, 0xC0]) + \
        struct.pack(">I", len(rle) + 4)[1:] + struct.pack(">H", w) + struct.pack(">H", h) + rle
    pcs = struct.pack(">H", canvas_w) + struct.pack(">H", 480) + bytes([0x10]) + \
        struct.pack(">H", 0) + bytes([0x80, 0x00, 0x00, 0x01]) + \
        struct.pack(">H", 0) + bytes([0, 0]) + struct.pack(">H", 40) + struct.pack(">H", 380)
    wds = bytes([1, 0]) + struct.pack(">H", 40) + struct.pack(">H", 380) + \
        struct.pack(">H", w) + struct.pack(">H", h)
    clear_pcs = struct.pack(">H", canvas_w) + struct.pack(">H", 480) + bytes([0x10]) + \
        struct.pack(">H", 1) + bytes([0x00, 0x00, 0x00, 0x00])
    blob = _seg(PCS, pts_ticks, pcs) + _seg(WDS, pts_ticks, wds) + \
        _seg(PDS, pts_ticks, pal) + _seg(ODS, pts_ticks, ods) + _seg(END, pts_ticks, b"")
    blob += _seg(PCS, end_ticks, clear_pcs) + _seg(END, end_ticks, b"")
    return blob


def selftest():
    cues = [
        (90000, 270000, "We have to leave right now."),       # 1.0s -> 3.0s
        (360000, 585000, "- Where is the money?\n- Under the old bridge."),  # 4.0 -> 6.5
    ]
    blob = b""
    for (a, b, t) in cues:
        blob += _synth_cue_segments(a, b, t)
    with tempfile.NamedTemporaryFile(suffix=".sup", delete=False) as tf:
        path = tf.name; tf.write(blob)
    try:
        parsed = parse_sup(path)
        vtt, n = to_vtt(parsed, "eng")
    finally:
        os.unlink(path)
    print("--- parsed %d cues, emitted %d ---" % (len(parsed), n))
    print(vtt)
    # assertions
    ok = True
    if len(parsed) != 2:
        ok = False; print("FAIL: expected 2 cues, got", len(parsed))
    if parsed:
        if abs(parsed[0]["start"] - 1.0) > 0.01 or abs(parsed[0]["end"] - 3.0) > 0.01:
            ok = False; print("FAIL: cue0 timing", parsed[0]["start"], parsed[0]["end"])
        if abs(parsed[1]["start"] - 4.0) > 0.01 or abs(parsed[1]["end"] - 6.5) > 0.01:
            ok = False; print("FAIL: cue1 timing", parsed[1]["start"], parsed[1]["end"])
    if "leave right now" not in vtt:
        ok = False; print("FAIL: cue0 text not OCR'd")
    if "money" not in vtt or "bridge" not in vtt:
        ok = False; print("FAIL: cue1 text not OCR'd")
    print("SELFTEST", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def main():
    if "--selftest" in sys.argv:
        selftest(); return
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        fail(2, "invalid json: " + str(e))
    sup = req.get("sup") or ""
    lang = req.get("lang") or TESS_LANG
    if not re.match(r"^[a-z+]{3,40}$", lang):
        lang = TESS_LANG
    if not sup:
        fail(2, "missing sup path")
    run(sup, lang)


if __name__ == "__main__":
    main()
