const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const fcmModule = import(pathToFileURL(
  path.join(root, 'supabase', 'functions', '_shared', 'fcm-error.mjs'),
).href);

function envelope(status, detailType, errorCode, message = '') {
  return JSON.stringify({
    error: {
      code: status,
      status: errorCode,
      message,
      details: [{ '@type': detailType, errorCode }],
    },
  });
}

test('FCM-specific invalid and unregistered tokens are purgeable', async () => {
  const { isInvalidFcmRegistrationResponse } = await fcmModule;
  const type = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
  assert.equal(isInvalidFcmRegistrationResponse(400, envelope(
    400, type, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token',
  )), true);
  assert.equal(isInvalidFcmRegistrationResponse(404, envelope(
    404, type, 'UNREGISTERED', 'Requested entity was not found.',
  )), true);
});

test('project, payload and transient failures never purge a valid token', async () => {
  const { isInvalidFcmRegistrationResponse } = await fcmModule;
  assert.equal(isInvalidFcmRegistrationResponse(400, envelope(
    400, 'type.googleapis.com/google.rpc.BadRequest', 'INVALID_ARGUMENT',
    "Invalid value at 'message.data[0].value'",
  )), false);
  assert.equal(isInvalidFcmRegistrationResponse(404, JSON.stringify({
    error: { code: 404, status: 'NOT_FOUND', message: 'Project not found.' },
  })), false);
  assert.equal(isInvalidFcmRegistrationResponse(429, JSON.stringify({
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' },
  })), false);
  assert.equal(isInvalidFcmRegistrationResponse(503, 'backend unavailable'), false);
  assert.equal(isInvalidFcmRegistrationResponse(503, 'upstream says UNREGISTERED'), false);
});
