const TEXT_LIMITS = Object.freeze({
  city: 96,
  region: 96,
  regionCode: 16,
});

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return normalized ? normalized.slice(0, limit) : null;
}

function cleanCountry(value) {
  const country = cleanText(value, 2)?.toUpperCase() || '';
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function cleanRegionCode(value) {
  const regionCode = cleanText(value, TEXT_LIMITS.regionCode);
  return regionCode && /^[A-Za-z0-9-]+$/.test(regionCode) ? regionCode : null;
}

export function onRequest({ request }) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: {
        'Allow': 'GET',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const cf = request.cf || {};
  const countryCode = cleanCountry(cf.country || request.headers.get('CF-IPCountry'));
  const regionCode = cleanRegionCode(cf.regionCode);
  const regionName = cleanText(cf.region, TEXT_LIMITS.region);
  const city = cleanText(cf.city, TEXT_LIMITS.city);

  return new Response(JSON.stringify({
    version: 1,
    available: Boolean(countryCode || regionCode || regionName || city),
    source: 'cloudflare_edge',
    countryCode,
    regionCode,
    regionName,
    city,
  }), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
