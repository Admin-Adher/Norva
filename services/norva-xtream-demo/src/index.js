/**
 * Norva Xtream demo source — TEST ONLY.
 *
 * A minimal Xtream-Codes-compatible endpoint that exposes ONE legal, freely
 * licensed movie so a real download can be recorded for the Google Play
 * FOREGROUND_SERVICE_DATA_SYNC declaration video. It is NOT a production source
 * and serves no third-party/copyrighted content.
 *
 * Movie: "Big Buck Bunny" (2008) © Blender Foundation — licensed CC BY 3.0
 * (https://peach.blender.org). Attribution is required; keep the credit in the
 * title below and in README.md. The bytes are proxied from a public host.
 *
 * Norva's Xtream client contract this satisfies (verified against
 * supabase/functions/_shared/xtream-sync.ts + norva-cloud validateCloudSource):
 *   - GET /player_api.php?username&password[&action]
 *       (no action | account_info) -> { user_info:{auth:1,...}, server_info }
 *       get_vod_categories -> [{category_id, category_name}]
 *       get_vod_streams    -> [{stream_id, name, container_extension, category_id, stream_icon, added}]
 *       get_vod_info       -> { info, movie_data }
 *       live/series actions -> []
 *   - GET /movie/{user}/{pass}/{stream_id}.{ext} -> the movie bytes (Range-aware)
 */

// Public, Range-capable host for the CC BY 3.0 film. Swap for a smaller encode
// (e.g. https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4)
// if you want the demo download to finish faster.
const MOVIE_UPSTREAM = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

const MOVIE = {
  num: 1,
  stream_id: 1,
  // Attribution lives in the visible title (CC BY 3.0 requirement).
  name: 'Big Buck Bunny (2008) — Blender Foundation — CC BY 3.0',
  title: 'Big Buck Bunny (2008) — Blender Foundation — CC BY 3.0',
  stream_type: 'movie',
  container_extension: 'mp4',
  category_id: '1',
  stream_icon: 'https://upload.wikimedia.org/wikipedia/commons/c/c5/Big_buck_bunny_poster_big.jpg',
  rating: '8',
  rating_5based: 4,
  added: '1211241600', // 2008-05-20
  custom_sid: '',
  direct_source: '',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

function playerApi(url) {
  const action = url.searchParams.get('action') || '';
  const username = url.searchParams.get('username') || 'demo';
  const password = url.searchParams.get('password') || 'demo';
  const nowSec = Math.floor(Date.now() / 1000);

  const userInfo = {
    username,
    password,
    message: 'Norva demo',
    auth: 1,
    status: 'Active',
    exp_date: '4102444800', // year 2100 — never expires for the test
    is_trial: '0',
    active_cons: '0',
    created_at: '1211241600',
    max_connections: '2',
    allowed_output_formats: ['mp4', 'ts', 'm3u8'],
  };
  const serverInfo = {
    url: url.hostname,
    port: '443',
    https_port: '443',
    server_protocol: 'https',
    rtmp_port: '0',
    timezone: 'UTC',
    timestamp_now: nowSec,
    time_now: new Date(nowSec * 1000).toISOString().replace('T', ' ').slice(0, 19),
  };

  switch (action) {
    case '':
    case 'account_info':
    case 'get_account_info':
      return json({ user_info: userInfo, server_info: serverInfo });
    case 'get_vod_categories':
      return json([{ category_id: '1', category_name: 'Demo — CC BY 3.0', parent_id: 0 }]);
    case 'get_vod_streams':
      return json([MOVIE]);
    case 'get_vod_info':
      return json({
        info: {
          name: MOVIE.name,
          o_name: MOVIE.name,
          movie_image: MOVIE.stream_icon,
          cover_big: MOVIE.stream_icon,
          releasedate: '2008-05-20',
          rating: '8',
          rating_count_kinopoisk: 0,
          duration_secs: 596,
          duration: '00:09:56',
          genre: 'Animation, Short',
          plot: 'Big Buck Bunny — an open movie by the Blender Foundation, licensed Creative Commons Attribution 3.0. Used here only as legal demo content.',
          container_extension: 'mp4',
        },
        movie_data: {
          stream_id: 1,
          name: MOVIE.name,
          added: MOVIE.added,
          category_id: '1',
          container_extension: 'mp4',
          custom_sid: '',
          direct_source: '',
        },
      });
    case 'get_live_categories':
    case 'get_series_categories':
      return json([]);
    case 'get_live_streams':
    case 'get_series':
      return json([]);
    default:
      return json([]);
  }
}

async function streamMovie(request) {
  // Proxy the bytes so the /movie/ URL always returns video regardless of the
  // caller following redirects. Forward Range/HEAD so seek + resume work.
  const range = request.headers.get('range');
  const upstream = await fetch(MOVIE_UPSTREAM, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: range ? { Range: range } : {},
  });
  const headers = new Headers(upstream.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('accept-ranges', 'bytes');
  if (!headers.get('content-type')) headers.set('content-type', 'video/mp4');
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/player_api.php' || p === '/panel_api.php') {
      return playerApi(url);
    }

    // /movie/{user}/{pass}/{id}.{ext}  (also accept /vod/… as an alias)
    if (/^\/(movie|vod)\/[^/]+\/[^/]+\/\d+\.[A-Za-z0-9]+$/.test(p)) {
      return streamMovie(request);
    }

    if (p === '/xmltv.php') {
      return new Response('<?xml version="1.0"?><tv></tv>', {
        headers: { 'content-type': 'application/xml' },
      });
    }

    return new Response(
      'Norva Xtream demo source (TEST ONLY).\n' +
      'Movie: Big Buck Bunny (2008) © Blender Foundation — CC BY 3.0 — https://peach.blender.org\n' +
      'Add to Norva as an Xtream source: serverUrl = this origin, any username/password.',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
};
