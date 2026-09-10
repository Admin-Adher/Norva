# Scoped adaptive-evidence gateway release

This operator does not change databases, flags, queues, Edge functions, provider configuration,
the existing Whisper binary/model, or the 99% / 200-file learning gate. `stage` builds only.
`deploy` and `rollback` are separate explicit operations. The original container is retained.

## Prerequisites

- Linux host Docker CLI/socket access as the normal Norva operator; no credentials are printed.
- The active gateway must still be the exact `strict-lid-extraction-20260910-fix3` image, health
  version 166, with normalized `index.js` SHA-256
  `ef0f9652b91adfecddfc070ab04731e021adeb407342a8f22a7e37ef56a055f5`.
- Existing Whisper and VAD runtime verification must be healthy, with all three digests present.
- No writable-layer modification may exist under `/app/src`, `/usr/local/bin`, or `/opt/whisper`.
- The new Linux ELF speech-segment helper must already be independently compiled and validated
  against the unchanged Whisper runtime. Obtain its SHA-256 independently of the staged digest.
- Test actual speech, silence and short audio in the **candidate image** with external networking disabled
  before deployment. A successful `--help` check is not a VAD accuracy or media test.
- All local playback, extraction, inference, startup reservations, pumps, and queues must be idle
  before replacement. The operator refuses busy or absent health fields; it never clears work.

Prepare one private revision directory on the host, for example:

```text
/home/adrien/.norva/strict-lid-adaptive-evidence-20260910/candidate-1/
  base/
    index.js
    strict-lid-inference.js
    strict-lid-window-checkpoint.js
  src/
    index.js
    strict-lid-inference.js
    strict-lid-window-checkpoint.js
    strict-lid-audio-evidence.js
    strict-lid-speech-window.js
    strict-lid-speech-sampler.js
  bin/
    whisper-vad-speech-segments
    vad-bin.sha256
```

`base/` contains reviewed exact live versions, not candidate versions. `vad-bin.sha256` is the
64-character lowercase SHA-256 digest (optional final newline), without a filename. Do not put
provider WAVs, transcripts, tokens or environment files in this directory. The operator builds
a new context containing only the six named JS modules, helper ELF, digest and generated
Dockerfile; its own private plans and inspect snapshots are outside that context.

## Invocation

From the host, using the full path to the reviewed operator script:

```text
python3 deploy-strict-lid-adaptive-evidence-20260910.py stage candidate-1 --vad-sha256 <independently-verified-sha256>
python3 deploy-strict-lid-adaptive-evidence-20260910.py deploy candidate-1
python3 deploy-strict-lid-adaptive-evidence-20260910.py rollback candidate-1
```

Do not run the second command until the bounded real VAD checks and deployment approval are
complete. `stage` runs an isolated syntax/hash/ELF invocation check, never the live gateway.
It does not create a credential-bearing clone or stop/restart the service.

After successful fixture tests only, write `vad-validation.private.json` beside the private plan
(not inside the build context), mode 0600. Deployment requires this exact proof structure:

```json
{
  "protocol": 1,
  "candidateImageIdentity": {"index": "<plan imageIdentity.index>", "manifest": "<plan imageIdentity.manifest>"},
  "vadSha256": "<independently verified helper digest>",
  "networkDisabled": true,
  "speechCasePassed": true,
  "silenceCasePassed": true,
  "shortCasePassed": true
}
```

Do not populate passed flags from a build or `--help` result. The proof binds the real tests to
the exact candidate image and binary and contains no source audio, transcripts, or credentials.

Deployment rechecks exact source/image/runtime/configuration and idle state, creates a stopped
clone with the preserved complete Docker configuration, then rechecks idle state immediately
before replacement. It checks all six active source hashes, helper/digest hashes, unchanged
Whisper runtime digests, gateway version 167, new sampler runtime health, and sampler protocol 1
inside `languageDetectEngine`. Rollback requires the original gateway version 166. Failure after replacement
automatically restores and verifies the exact original container.

Plans are exclusive-create and never overwritten. A failed staging attempt leaves its private
artifacts intact; inspect the closed error and use a fresh bounded revision (`candidate-2`, etc.)
after resolving it. A deployment plan cannot be replayed. Explicit rollback requires this exact
candidate to be active and idle. No container or data directory is deleted by this operator.

## Local tests (no server access)

```text
python3 tests/strict-lid-adaptive-deployment.test.py
```

Tests cover the exact allowlist, private context isolation, digest agreement, idle gates,
configuration and mount equality, closed runtime gates, no-start staging, and rollback ordering.
