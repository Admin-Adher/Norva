// Workers ignores a manually supplied Content-Length for an arbitrary stream.
// The revocation wrapper must retain a known byte length so native media clients
// can seek instead of treating a progressive file as a non-seekable live body.
export function preserveRelayResponseLength(body, headers) {
  if (!body || typeof body.pipeTo !== "function"
      || typeof globalThis.FixedLengthStream !== "function") return body;
  const encoding = (headers.get("content-encoding") || "").trim().toLowerCase();
  // The decoded body of an encoded response may not have the wire byte length.
  if (encoding && encoding !== "identity") return body;
  const raw = headers.get("content-length");
  if (!/^(0|[1-9]\d*)$/.test(raw || "")) return body;
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) return body;
  const { readable, writable } = new FixedLengthStream(length);
  // pipeTo propagates cancellation upstream and errors to the response stream.
  // Its rejected promise is expected when the viewer seeks or closes playback.
  void body.pipeTo(writable).catch(() => {});
  return readable;
}
