#!/usr/bin/env python3
"""
Build-time: download the Argos translation models for a configured language set and
normalise them into $ARGOS_MODELS_DIR/<from>_<to>/{model/, sentencepiece.model, metadata.json}.

We install en<->X for every X in ARGOS_LANGS (default below). English is the pivot, so this
set defines BOTH the selectable target languages AND the source languages we can translate
FROM (a source with no en model simply isn't offered). Each .argosmodel is a zip whose inner
top-level folder name is inconsistent, and carries a `stanza/` sentence-segmenter we don't use
(we translate cue-by-cue) — so we flatten to a deterministic path and drop stanza/ + README to
keep the image smaller. Idempotent: an already-populated pair is skipped.

Env:
  ARGOS_LANGS       comma list of non-English languages (default: fr,es,ar,de,it,pt)
  ARGOS_MODELS_DIR  output dir (default: /opt/argos-models)
  ARGOS_INDEX_URL   override the package index URL
"""
import os, sys, json, time, zipfile, shutil, tempfile, urllib.request

LANGS = [s.strip().lower() for s in os.environ.get("ARGOS_LANGS", "fr,es,ar,de,it,pt").split(",") if s.strip()]
OUT = os.environ.get("ARGOS_MODELS_DIR", "/opt/argos-models")
INDEX_URL = os.environ.get("ARGOS_INDEX_URL", "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json")


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "norva-gateway-build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def download_to_file(url, path, attempts=4):
    """Stream a (possibly large) file to disk with chunked reads + retries. Big Argos models
    truncate on a single buffered read; resume with a Range header when the server allows it."""
    last = None
    for attempt in range(1, attempts + 1):
        have = os.path.getsize(path) if os.path.exists(path) else 0
        headers = {"User-Agent": "norva-gateway-build"}
        if have:
            headers["Range"] = f"bytes={have}-"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=180) as r:
                total = r.headers.get("Content-Length")
                resuming = have and r.status == 206
                mode = "ab" if resuming else "wb"
                if not resuming:
                    have = 0
                with open(path, mode) as f:
                    while True:
                        chunk = r.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
            expect = None
            try:
                expect = int(total) + (os.path.getsize(path) - have if resuming else 0) if total else None
            except Exception:
                expect = None
            # Verify it's a complete zip (cheap structural check).
            if zipfile.is_zipfile(path):
                return
            last = RuntimeError("incomplete / not a zip")
        except Exception as e:
            last = e
        print(f"    retry {attempt}/{attempts} ({last})", file=sys.stderr)
        time.sleep(min(2 ** attempt, 10))
    raise last or RuntimeError("download failed")


def normalise(zpath, frm, to):
    """Extract the zip and move model/ + sentencepiece.model + metadata.json to OUT/<frm>_<to>/."""
    dest = os.path.join(OUT, f"{frm}_{to}")
    if os.path.exists(os.path.join(dest, "model", "model.bin")):
        print(f"  = {frm}->{to} already present, skip")
        return
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        # find the inner dir that contains model/model.bin
        anchor = next((n for n in names if n.endswith("model/model.bin")), None)
        if not anchor:
            raise RuntimeError(f"{frm}->{to}: no model/model.bin in package")
        root = anchor[: -len("model/model.bin")]  # inner prefix incl. trailing slash
        tmp = dest + ".tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        for n in names:
            if not n.startswith(root) or n.endswith("/"):
                continue
            rel = n[len(root):]
            # keep only what we need at runtime
            if not (rel.startswith("model/") or rel in ("sentencepiece.model", "metadata.json")):
                continue
            target = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(n) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
        shutil.rmtree(dest, ignore_errors=True)
        os.replace(tmp, dest)
    print(f"  + {frm}->{to}")


def main():
    os.makedirs(OUT, exist_ok=True)
    index = json.loads(http_get(INDEX_URL))
    wanted = set()
    for x in LANGS:
        wanted.add(("en", x))
        wanted.add((x, "en"))
    by_pair = {}
    for e in index:
        pair = (e.get("from_code"), e.get("to_code"))
        if pair in wanted:
            link = (e.get("links") or [None])[0]
            if link:
                # prefer the highest package_version if duplicated
                prev = by_pair.get(pair)
                if not prev or str(e.get("package_version", "")) > str(prev[0]):
                    by_pair[pair] = (e.get("package_version", ""), link)
    missing = wanted - set(by_pair)
    if missing:
        print("WARNING: no index entry for: " + ", ".join(f"{a}->{b}" for a, b in sorted(missing)), file=sys.stderr)
    print(f"Fetching {len(by_pair)} Argos models into {OUT} (langs: en<->{','.join(LANGS)})")
    failed = 0
    for (frm, to), (ver, link) in sorted(by_pair.items()):
        if os.path.exists(os.path.join(OUT, f"{frm}_{to}", "model", "model.bin")):
            print(f"  = {frm}->{to} already present, skip")
            continue
        tmp = os.path.join(tempfile.gettempdir(), f"argos-{frm}_{to}.argosmodel")
        try:
            print(f"  ↓ {frm}->{to} v{ver} {link}")
            download_to_file(link, tmp)
            normalise(tmp, frm, to)
        except Exception as e:
            failed += 1
            print(f"  ! {frm}->{to} FAILED: {e}", file=sys.stderr)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    if failed:
        print(f"{failed} model(s) failed to download", file=sys.stderr)
        sys.exit(1)
    print("Argos models ready.")


if __name__ == "__main__":
    main()
