/**
 * FCM reuses HTTP 400/404 for both invalid registrations and unrelated request
 * or project errors. Delete a stored token only when the response identifies
 * the FCM-specific registration error, never from the HTTP status alone.
 */
export function isInvalidFcmRegistrationResponse(status, text) {
  let payload = {};
  try { payload = JSON.parse(text || '{}'); } catch { /* bounded fallback below */ }
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  const fcmSpecific = details.some((detail) => {
    const type = String(detail?.['@type'] ?? '');
    const code = String(detail?.errorCode ?? detail?.error_code ?? '').toUpperCase();
    return type === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
      && (code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT');
  });
  if (fcmSpecific) return true;

  const topLevelStatus = String(payload?.error?.status ?? '').toUpperCase();
  const message = String(payload?.error?.message ?? '');
  if (status === 404 && topLevelStatus === 'UNREGISTERED') return true;
  if (status !== 400 && status !== 404) return false;
  return /\bUNREGISTERED\b|registration-token-not-registered|registration token is not a valid FCM registration token/i
    .test(message || String(text ?? ''));
}
