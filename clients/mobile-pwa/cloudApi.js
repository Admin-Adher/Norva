/**
 * Norva Cloud client shared by the mobile PWA.
 */
(function () {
  'use strict';

  const DEFAULT_API_URL = 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-cloud';
  const KEY_API_URL = 'norva-cloud-api-url';
  const KEY_TOKEN = 'norva-cloud-token';
  const KEY_DEVICE_TOKEN = 'norva-cloud-device-token';

  function apiBase() {
    const configured = localStorage.getItem(KEY_API_URL) || window.NORVA_CLOUD_API_URL || DEFAULT_API_URL;
    return configured.replace(/\/+$/, '');
  }

  function getToken() {
    return localStorage.getItem(KEY_TOKEN) || window.NORVA_CLOUD_TOKEN || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem(KEY_TOKEN, token);
    else localStorage.removeItem(KEY_TOKEN);
  }

  function getDeviceToken() {
    return localStorage.getItem(KEY_DEVICE_TOKEN) || window.NORVA_CLOUD_DEVICE_TOKEN || '';
  }

  function setDeviceToken(token) {
    if (token) localStorage.setItem(KEY_DEVICE_TOKEN, token);
    else localStorage.removeItem(KEY_DEVICE_TOKEN);
  }

  function setApiUrl(url) {
    if (url) localStorage.setItem(KEY_API_URL, url.replace(/\/+$/, ''));
    else localStorage.removeItem(KEY_API_URL);
  }

  async function request(method, path, body, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    const token = options.token === undefined ? getToken() : options.token;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body)
    });

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : { error: await response.text().catch(() => '') };

    if (!response.ok) {
      const error = new Error(payload.error || payload.message || `Norva responded with ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function query(params) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') search.set(key, value);
    });
    const stringified = search.toString();
    return stringified ? `?${stringified}` : '';
  }

  window.NorvaCloud = {
    get apiUrl() { return apiBase(); },
    get token() { return getToken(); },
    get deviceToken() { return getDeviceToken(); },
    setToken,
    setDeviceToken,
    setApiUrl,
    health: () => request('GET', '/health', null, { token: '' }),
    profile: {
      get: () => request('GET', '/profile'),
      save: (profile) => request('PUT', '/profile', profile)
    },
    devices: {
      list: () => request('GET', '/devices'),
      create: (device) => request('POST', '/devices', device),
      heartbeat: (id) => request('PATCH', `/devices/${encodeURIComponent(id)}/heartbeat`),
      revoke: (id) => request('DELETE', `/devices/${encodeURIComponent(id)}`)
    },
    sources: {
      list: () => request('GET', '/sources'),
      create: (source) => request('POST', '/sources', source),
      update: (id, patch) => request('PATCH', `/sources/${encodeURIComponent(id)}`, patch),
      sync: (id) => request('POST', `/sources/${encodeURIComponent(id)}/sync`, {}),
      remove: (id) => request('DELETE', `/sources/${encodeURIComponent(id)}`)
    },
    mediaItems: {
      list: (params = {}) => request('GET', `/media-items${query(params)}`),
      upsert: (sourceId, items) => request('POST', '/media-items', { sourceId, items })
    },
    favorites: {
      list: (params = {}) => request('GET', `/favorites${query(params)}`),
      add: (favorite) => request('POST', '/favorites', favorite),
      remove: (id) => request('DELETE', `/favorites/${encodeURIComponent(id)}`)
    },
    history: {
      list: (params = {}) => request('GET', `/history${query(params)}`),
      save: (item) => request('POST', '/history', item),
      remove: (id) => request('DELETE', `/history/${encodeURIComponent(id)}`)
    },
    pairing: {
      start: (device) => request('POST', '/pairing/start', device, { token: '' }),
      poll: (code, pairingSecret = '') => request(
        'GET',
        `/pairing/${encodeURIComponent(String(code).toUpperCase())}${pairingSecret ? `?secret=${encodeURIComponent(pairingSecret)}` : ''}`,
        null,
        { token: '' }
      ),
      approve: (code) => request('POST', '/pairing/approve', { code })
    },
    commands: {
      list: (params = {}) => request('GET', `/commands${query(params)}`),
      queue: (command) => request('POST', '/commands', command),
      update: (id, patch) => request('PATCH', `/commands/${encodeURIComponent(id)}`, patch)
    },
    playback: {
      createSession: (session) => request('POST', '/playback/sessions', session),
      getSession: (id) => request('GET', `/playback/sessions/${encodeURIComponent(id)}`),
      expireSession: (id) => request('POST', `/playback/sessions/${encodeURIComponent(id)}/expire`)
    },
    device: {
      me: () => request('GET', '/device/me', null, { token: getDeviceToken() }),
      heartbeat: () => request('POST', '/device/heartbeat', {}, { token: getDeviceToken() }),
      commands: () => request('GET', '/device/commands', null, { token: getDeviceToken() }),
      acknowledgeCommand: (id) => request('PATCH', `/device/commands/${encodeURIComponent(id)}`, { status: 'acknowledged' }, { token: getDeviceToken() }),
      failCommand: (id, error) => request('PATCH', `/device/commands/${encodeURIComponent(id)}`, { status: 'failed', error }, { token: getDeviceToken() })
    }
  };
})();
