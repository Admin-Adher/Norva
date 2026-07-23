package tv.norva.phone;

import android.app.Activity;
import android.app.AlertDialog;
import android.net.Uri;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import java.util.ArrayList;
import java.util.List;

/**
 * Chromecast support for the native player, without AppCompat: route discovery
 * through androidx.mediarouter, a plain AlertDialog as the device picker, and
 * the Cast framework session/RemoteMediaClient for playback control.
 *
 * The Chromecast fetches the stream URL itself from the HOME network (same
 * residential IP as the phone), so the provider's single-connection/IP rules
 * behave exactly as for local playback — and the local player is paused the
 * moment the cast session starts, so only one provider connection exists.
 *
 * Everything is best-effort: devices without Google Play services simply never
 * see the cast button.
 */
final class CastSupport {

    interface Listener {
        /** Cast devices appeared/disappeared on the network. */
        void onRouteAvailabilityChanged(boolean available);
        /** A session is up; local playback should hand over. */
        void onCastStarted(String deviceName);
        /** Session finished; resume locally near this position (ms, 0 if unknown). */
        void onCastEnded(long resumePositionMs);
    }

    private final Activity activity;
    private final Listener listener;
    private MediaRouter mediaRouter;
    private MediaRouteSelector selector;
    private CastContext castContext;
    private boolean started = false;

    private final MediaRouter.Callback routeCallback = new MediaRouter.Callback() {
        @Override public void onRouteAdded(MediaRouter router, MediaRouter.RouteInfo route) { notifyRoutes(); }
        @Override public void onRouteRemoved(MediaRouter router, MediaRouter.RouteInfo route) { notifyRoutes(); }
        @Override public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) { notifyRoutes(); }
    };

    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override public void onSessionStarted(CastSession session, String sessionId) {
            listener.onCastStarted(deviceName(session));
        }
        @Override public void onSessionResumed(CastSession session, boolean wasSuspended) {
            listener.onCastStarted(deviceName(session));
        }
        @Override public void onSessionEnded(CastSession session, int error) {
            listener.onCastEnded(lastKnownPosition(session));
        }
        @Override public void onSessionStarting(CastSession session) { }
        @Override public void onSessionStartFailed(CastSession session, int error) { }
        @Override public void onSessionEnding(CastSession session) { }
        @Override public void onSessionResuming(CastSession session, String sessionId) { }
        @Override public void onSessionResumeFailed(CastSession session, int error) { }
        @Override public void onSessionSuspended(CastSession session, int reason) { }
    };

    CastSupport(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    /** Begin discovery. No-op (and no crash) without Google Play services. */
    void start() {
        try {
            castContext = CastContext.getSharedInstance(activity.getApplicationContext());
            mediaRouter = MediaRouter.getInstance(activity.getApplicationContext());
            selector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(
                            CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .build();
            mediaRouter.addCallback(selector, routeCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY);
            castContext.getSessionManager().addSessionManagerListener(sessionListener, CastSession.class);
            started = true;
            notifyRoutes();
        } catch (Throwable ignored) {
            // No Play services / no Cast module: the button just never shows.
        }
    }

    void stop() {
        if (!started) return;
        try { mediaRouter.removeCallback(routeCallback); } catch (Exception ignored) { }
        try { castContext.getSessionManager().removeSessionManagerListener(sessionListener, CastSession.class); } catch (Exception ignored) { }
        started = false;
    }

    private void notifyRoutes() {
        listener.onRouteAvailabilityChanged(!castRoutes().isEmpty());
    }

    private List<MediaRouter.RouteInfo> castRoutes() {
        List<MediaRouter.RouteInfo> result = new ArrayList<>();
        if (mediaRouter == null || selector == null) return result;
        for (MediaRouter.RouteInfo route : mediaRouter.getRoutes()) {
            if (route.matchesSelector(selector) && !route.isDefault()) result.add(route);
        }
        return result;
    }

    /** Plain-dialog device picker (no AppCompat MediaRouteButton machinery). */
    void showRoutePicker() {
        final List<MediaRouter.RouteInfo> routes = castRoutes();
        if (routes.isEmpty()) return;
        CastSession current = currentSession();
        if (current != null) {
            // Already casting → the picker becomes the disconnect affordance.
            new AlertDialog.Builder(activity)
                    .setTitle(activity.getString(R.string.player_cast_active_title))
                    .setMessage(activity.getString(
                            R.string.player_cast_connected_to, deviceName(current)))
                    .setPositiveButton(activity.getString(R.string.player_cast_stop_streaming),
                            (d, w) -> endSession())
                    .setNegativeButton("Fermer", null)
                    .show();
            return;
        }
        String[] names = new String[routes.size()];
        for (int i = 0; i < routes.size(); i++) names[i] = routes.get(i).getName();
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.player_cast_picker_title))
                .setItems(names, (d, which) -> {
                    try { mediaRouter.selectRoute(routes.get(which)); } catch (Exception ignored) { }
                })
                .setNegativeButton("Annuler", null)
                .show();
    }

    /** Hand the stream to the receiver (it fetches the URL itself). */
    void loadMedia(String url, String title, String posterUrl, long positionMs, boolean live) {
        CastSession session = currentSession();
        if (session == null || url == null || url.isEmpty()) return;
        try {
            RemoteMediaClient rmc = session.getRemoteMediaClient();
            if (rmc == null) return;
            MediaMetadata meta = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
            if (title != null) meta.putString(MediaMetadata.KEY_TITLE, title);
            if (posterUrl != null && !posterUrl.isEmpty()) {
                try {
                    meta.addImage(new com.google.android.gms.common.images.WebImage(Uri.parse(posterUrl)));
                } catch (Exception ignored) { }
            }
            MediaInfo info = new MediaInfo.Builder(url)
                    .setStreamType(live ? MediaInfo.STREAM_TYPE_LIVE : MediaInfo.STREAM_TYPE_BUFFERED)
                    .setContentType(contentTypeFor(url))
                    .setMetadata(meta)
                    .build();
            rmc.load(new MediaLoadRequestData.Builder()
                    .setMediaInfo(info)
                    .setAutoplay(true)
                    .setCurrentTime(Math.max(0, positionMs))
                    .build());
        } catch (Exception ignored) { }
    }

    void toggleRemotePlayback() {
        try {
            RemoteMediaClient rmc = currentSession() == null ? null : currentSession().getRemoteMediaClient();
            if (rmc != null) rmc.togglePlayback();
        } catch (Exception ignored) { }
    }

    void endSession() {
        try { castContext.getSessionManager().endCurrentSession(true); } catch (Exception ignored) { }
    }

    boolean isCasting() {
        return currentSession() != null;
    }

    private CastSession currentSession() {
        try {
            CastSession s = castContext == null ? null
                    : castContext.getSessionManager().getCurrentCastSession();
            return (s != null && s.isConnected()) ? s : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String deviceName(CastSession session) {
        try {
            return session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : "Chromecast";
        } catch (Exception e) {
            return "Chromecast";
        }
    }

    private static long lastKnownPosition(CastSession session) {
        try {
            RemoteMediaClient rmc = session.getRemoteMediaClient();
            return rmc == null ? 0 : Math.max(0, rmc.getApproximateStreamPosition());
        } catch (Exception e) {
            return 0;
        }
    }

    /** Receiver-side MIME hint from the URL extension. */
    private static String contentTypeFor(String url) {
        String u = url.toLowerCase();
        int q = u.indexOf('?');
        if (q > 0) u = u.substring(0, q);
        if (u.endsWith(".m3u8") || u.contains("playlist.m3u8")) return "application/x-mpegURL";
        if (u.endsWith(".mkv")) return "video/x-matroska";
        if (u.endsWith(".webm")) return "video/webm";
        if (u.endsWith(".ts")) return "video/mp2t";
        if (u.endsWith(".avi")) return "video/x-msvideo";
        return "video/mp4";
    }
}
