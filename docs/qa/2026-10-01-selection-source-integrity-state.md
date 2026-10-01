# Durable classification of a proven incomplete Selection source

The authenticated capture API now maps the exact HTTP 422 /
MP4_DECLARED_MEDIA_EXCEEDS_FILE response to SELECTION_AUDIO_SOURCE_TRUNCATED
only when providerDrained=true and providerDrainProtocol=1. Other routes,
HTTP errors and missing drain proofs retain their existing classifications.

The worker already persists fixed error codes through its lease-checked finish
RPC. A focused replay proves this new terminal reason retains the previous
three window receipts, performs no language hydration and requests no retry.
The existing SQL accepts this bounded code; no schema change is required.

Validation: 39 gateway/client/worker tests passed. Production publication and
a real durable-job outcome remain unverified. This does not add a catalogue
warning or repair missing source bytes; it supplies the server-side reason
needed before presenting a trustworthy warning to the user.
