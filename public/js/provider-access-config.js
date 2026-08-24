// UI rollout gate. The durable database and Edge flags remain authoritative;
// this client gate prevents pre-activation builds from collecting a period that
// the server is still configured to reject. Phase 16 may set the global to true
// before this script loads for a bounded web/phone canary.
window.NORVA_PROVIDER_ACCESS_UI_V1 = window.NORVA_PROVIDER_ACCESS_UI_V1 === true;
