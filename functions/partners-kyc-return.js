const WEB_RETURN_LOCATION = "/app.html#partners";
const ANDROID_RETURN_LOCATION = "/app.html?mobile=1#partners";

function returnLocation(request) {
  const userAgent = request.headers.get("User-Agent") || "";
  return /(?:^|\s)NorvaTV-AndroidPhone\/\d+(?:\.\d+)*(?:\s|$)/.test(userAgent)
    ? ANDROID_RETURN_LOCATION
    : WEB_RETURN_LOCATION;
}

function privateHeaders(extra = {}) {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

export function onRequest({ request }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: privateHeaders({ Allow: "GET, HEAD" }),
    });
  }

  // Didit appends provider-controlled query parameters to its callback URL.
  // This boundary deliberately ignores the full URL and carries no provider
  // identifier or decision into the application, browser history or referrer.
  return new Response(null, {
    status: 303,
    headers: privateHeaders({ Location: returnLocation(request) }),
  });
}
