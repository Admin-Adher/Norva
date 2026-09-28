# HTTP HLS codec probe compatibility

## Evidence

The ordinary-owner 1% metadata cohort encountered `codec_probe_invalid_media`
on a provider URL returning HTTP 200 and an HLS playlist. A bounded probe under
the provider and file leases reported an FFprobe extension-policy rejection.
No credentials or complete provider URLs are recorded here.

Using the production Gateway image `norva-media-gateway:native-ts-lookbehind-20260928`
in a disposable container with `--network none`, a loopback fixture establishes:

- A valid MPEG-TS segment named `segment.jpg` fails the default probe.
- With `extension_picky=0`, the same segment and an extensionless segment succeed.
- An ordinary MP4 still produces a video stream.
- An HLS playlist referencing `file:///tmp/segment.ts` is blocked by the explicit
  network protocol whitelist, even though the file exists.

Reproduction: pipe `tests/fixtures/hls-probe-extension-runtime.cjs` into
`docker run --rm -i --network none --entrypoint node <Gateway image> -`.

The change applies only to HTTP(S) codec probes. Existing background-provider
admission, viewer preemption and child-process drain handling are unchanged.
27 focused input-option, refresh and preemption tests pass; `git diff --check` passes.

## Remaining validation

This is a local candidate, not a production deployment. Integration, deployment
on both Gateways and a bounded replay of the real provider playlist remain.
This does not prove Android playback or successful strict language identification.
Metadata rollout remains at 1% pending positive end-to-end evidence.
