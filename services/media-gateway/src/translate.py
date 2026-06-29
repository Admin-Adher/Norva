#!/usr/bin/env python3
"""
Phase 3b — offline subtitle translation with Argos (CTranslate2) models.

Invoked per job by the Node gateway: reads a JSON request on stdin
  { "vtt": "<source WEBVTT>", "source": "<2-3 letter lang>", "target": "<2-3 letter lang>" }
and writes the translated WEBVTT to stdout (same cue timings, translated cue text).

Deliberately uses CTranslate2 + SentencePiece DIRECTLY (not the full `argostranslate`
package) so the image stays light — no torch / stanza / spacy. We translate cue text
line-by-line, which is short enough that document-level sentence segmentation isn't
needed. Arbitrary language pairs go through English as a pivot (source->en->target),
exactly like Argos itself.

Exit codes: 0 ok · 2 bad request · 3 unsupported language pair · 4 translation error.
Model files live under $ARGOS_MODELS_DIR/<from>_<to>/{model/, sentencepiece.model}.
"""
import sys, os, json, re

MODELS_DIR = os.environ.get("ARGOS_MODELS_DIR", "/opt/argos-models")
THREADS = int(os.environ.get("ARGOS_THREADS", "4"))
BEAM = int(os.environ.get("ARGOS_BEAM", "4"))
# A token carrying at least one (non-digit, non-underscore) letter — pure punctuation /
# numbers / music glyphs ("...", "42", "♪") are kept verbatim (the model hallucinates on them).
HAS_ALPHA = re.compile(r"[^\W\d_]", re.UNICODE)
LANG_RE = re.compile(r"^[a-z]{2,3}$")
SPM_SPACE = "▁"  # SentencePiece word-boundary marker


def fail(code, msg):
    sys.stderr.write(json.dumps({"error": msg}) + "\n")
    sys.exit(code)


def model_dir(frm, to):
    d = os.path.join(MODELS_DIR, f"{frm}_{to}")
    return d if os.path.exists(os.path.join(d, "model", "model.bin")) else None


def hop_chain(source, target):
    """Ordered list of (from, to) model hops, or None if the pair can't be served."""
    if source == target:
        return []
    if model_dir(source, target):
        return [(source, target)]
    if source != "en" and target != "en" and model_dir(source, "en") and model_dir("en", target):
        return [(source, "en"), ("en", target)]
    return None


_cache = {}


def load(frm, to):
    key = (frm, to)
    if key not in _cache:
        import ctranslate2, sentencepiece as spm
        base = model_dir(frm, to)
        translator = ctranslate2.Translator(
            os.path.join(base, "model"), device="cpu", inter_threads=1, intra_threads=THREADS,
        )
        sp = spm.SentencePieceProcessor(model_file=os.path.join(base, "sentencepiece.model"))
        _cache[key] = (translator, sp)
    return _cache[key]


def _detok(pieces):
    return "".join(pieces).replace(SPM_SPACE, " ").strip()


def translate_lines(lines, hops, batch=64):
    """Translate each line through every hop. Empty / non-alphabetic lines pass through
    untouched; leading whitespace (subtitle indentation) is preserved."""
    cur = list(lines)
    for (frm, to) in hops:
        translator, sp = load(frm, to)
        idxs = [i for i, ln in enumerate(cur) if ln.strip() and HAS_ALPHA.search(ln)]
        for s in range(0, len(idxs), batch):
            grp = idxs[s:s + batch]
            toks = [sp.encode(cur[i].strip(), out_type=str) for i in grp]
            res = translator.translate_batch(
                toks, beam_size=BEAM, no_repeat_ngram_size=3, max_decoding_length=256,
            )
            for k, i in enumerate(grp):
                src = cur[i]
                lead = src[:len(src) - len(src.lstrip())]
                cur[i] = lead + _detok(res[k].hypotheses[0])
    return cur


def translate_vtt(vtt, hops):
    """Re-emit the VTT with translated cue text. Headers, cue ids, timestamps and blank
    lines are left exactly as they are; only the text lines inside a cue are translated."""
    lines = vtt.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out, text_idx, in_cue = [], [], False
    for ln in lines:
        s = ln.strip()
        if "-->" in ln:                 # timestamp line → cue text follows
            in_cue = True
            out.append(ln)
        elif s == "":                   # blank line ends the cue block
            in_cue = False
            out.append(ln)
        elif in_cue and not s.startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            text_idx.append(len(out))
            out.append(ln)             # placeholder; translated below
        else:
            out.append(ln)
    if hops:
        translated = translate_lines([out[i] for i in text_idx], hops)
        for j, i in enumerate(text_idx):
            out[i] = translated[j]
    return "\n".join(out)


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        fail(2, "invalid json: " + str(e))
    vtt = req.get("vtt") or ""
    source = (req.get("source") or "").lower()
    target = (req.get("target") or "").lower()
    if not vtt.strip():
        fail(2, "empty vtt")
    if not LANG_RE.match(source) or not LANG_RE.match(target):
        fail(2, "bad lang code")
    hops = hop_chain(source, target)
    if hops is None:
        fail(3, "unsupported pair %s->%s" % (source, target))
    try:
        out = translate_vtt(vtt, hops)
    except Exception as e:
        fail(4, "translate error: " + str(e))
    sys.stdout.write(out)


if __name__ == "__main__":
    main()
