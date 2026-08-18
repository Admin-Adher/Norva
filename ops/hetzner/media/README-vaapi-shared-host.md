# Norva media Gateway on the existing Hetzner host (VAAPI)

Status: private Gateway promoted on the existing host; still loopback-only,
with the Edge callback pinned to `127.0.0.1:9` and no browser/public traffic.

This is the current cost-conscious target for the Ryzen 7 PRO 8700GE host that
already runs the self-hosted Supabase stack. It does not require a GEX44.

## Physical evidence (2026-08-17)

- 8 cores / 16 threads, 61 GiB RAM, 337 GiB disk free at measurement time.
- AMD Radeon 780M exposed as `/dev/dri/renderD128` through `amdgpu`.
- Mesa VAAPI exposes H.264 High encode and HEVC Main/Main10 encode.
- Norva's exact 1080p30 HLS graph encoded 12 seconds at 19.6x realtime.
- Six independent 2-second MPEG-TS segments were produced, `ENDLIST` was
  present, and a full FFmpeg decode check returned `HLS_DECODE_OK`.

The Mesa `os_same_file_description` warning was non-terminal in both the codec
smoke and exact HLS run. The service startup still executes its own one-frame
H.264 VAAPI preflight and fails closed if the real container cannot encode.

## Isolation contract

- One Gateway process and private local cache only; no shared-volume replicas.
- Six logical CPUs maximum, 10 GiB hard RAM limit, 512 PIDs.
- Nice level 10 and best-effort I/O priority 7.
- Four simultaneous video encoders maximum. Video copy/remux and local cache
  hits do not consume these slots.
- Cache capped at 96 GiB and refuses publication below 160 GiB host free space.
- Container has no Linux capabilities and receives only the DRM render node.
- Port is loopback-only. TLS/reverse proxy remains mandatory.

These bounds leave ten logical CPUs and more than 50 GiB of host RAM outside the
Gateway cgroup. They are a conservative canary envelope, not a claim that media
and PostgreSQL can never contend; host CPU, disk latency and DB health remain
rollout gates.

## Files

- `docker-compose.vaapi.yml`: bounded single-instance runtime.
- `env.media-vaapi.example`: secret-free environment template to copy as
  `.env.media-vaapi` only on the server.
- `soak-private-vaapi-gateway.sh`: read-only, revision-pinned five-minute idle
  soak for the promoted image.
- `services/media-gateway/Dockerfile`: production image with FFmpeg and Mesa.

## Rollout order

1. **Complete:** validate compose rendering and build without starting the service.
2. **Complete:** start the Gateway on the loopback port only and verify `/health` reports
   `videoEncoder.backend=vaapi`, `ready=true`, and complete cache enabled.
3. **Complete for focused smokes:** H.264/AAC copy, H.264/EAC3 audio-only
   transcode, and HEVC/EAC3 VAAPI full transcode. Run the full fixed Strategy
   Lab corpus separately.
4. Run the revision-pinned idle soak, then connect one exact account hash to
   the internal Gateway while Railway remains authoritative for every other account.
5. Configure the public TLS media origin only
   after explicit authorization.
6. Observe DB latency, load, disk free space, HLS startup and terminal 458s;
   rollback by restoring the Edge URL to Railway.

No step authorizes a Git push, DNS change, Edge secret change, or production
traffic by itself.
