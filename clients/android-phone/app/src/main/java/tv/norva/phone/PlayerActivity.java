package tv.norva.phone;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.DisplayCutout;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

/**
 * Norva phone/tablet native player (ExoPlayer / media3).
 *
 * Plays the stream directly from the user's home network (residential IP) with
 * hardware decoders, and reports the final position back so the cloud history
 * resumes on other devices. Touch controls come from media3-ui PlayerView.
 */
public class PlayerActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SOURCE_ID = "sourceId";
    public static final String EXTRA_ITEM_TYPE = "itemType";
    public static final String EXTRA_ITEM_ID = "itemId";
    public static final String EXTRA_RESUME_SECONDS = "resumeSeconds";
    // Gateway byte-pipe URL to retry with if the direct provider URL is refused
    // (e.g. the provider 401s this device's residential IP).
    public static final String EXTRA_FALLBACK_URL = "fallbackUrl";
    // Offline (encrypted local file) playback.
    public static final String EXTRA_LOCAL = "local";
    public static final String EXTRA_WRAPPED_KEY = "wrappedKey";
    public static final String EXTRA_KEY_IV = "keyIv";
    public static final String EXTRA_MEDIA_IV = "mediaIv";
    public static final String EXTRA_CONTAINER = "container";

    // IPTV providers gate on User-Agent and REJECT a browser UA (this provider 401s
    // it). Use the VLC UA the relay/gateway use successfully — the working default
    // for the whole stack (the cloud sends no UA, so the relay falls back to VLC).
    private static final String UA = "VLC/3.0.20 LibVLC/3.0.20";

    private ExoPlayer player;
    private PlayerView playerView;
    private LinearLayout errorPanel;     // recoverable error UI (message + Retry + Back)
    private TextView errorView;          // the diagnostic detail line inside errorPanel
    private String streamHost;           // host of the stream URL, included in the error text
    private String originalUrl;          // the first URL we tried, used to re-prepare on Retry
    private MediaItem originalMediaItem; // built once, replayed on Retry (carries the local MIME hint)
    private boolean isLocal = false;     // offline (encrypted local file) playback
    private String fallbackUrl;          // gateway URL to retry with on a direct-URL refusal
    private boolean fallbackTried = false;
    private String sourceId;
    private String itemType;
    private String itemId;
    private String subKey; // SharedPreferences key for the per-title subtitle choice
    private int resumeSeconds = 0;
    private boolean resumeApplied = false;
    private TextView seekBubble;         // transient "+10s" / "-10s" double-tap feedback
    private final Runnable hideSeekBubble = new Runnable() {
        @Override public void run() { if (seekBubble != null) seekBubble.setVisibility(View.GONE); }
    };

    private final Handler errHandler = new Handler(Looper.getMainLooper());
    private static final long BUFFER_TIMEOUT_MS = 35_000L; // "no data" watchdog
    private final Runnable bufferWatchdog = new Runnable() {
        @Override
        public void run() {
            showStreamError(getString(R.string.player_no_data)
                    + (streamHost != null ? "\nHost: " + streamHost : ""));
        }
    };

    @OptIn(markerClass = UnstableApi.class)
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url = getIntent().getStringExtra(EXTRA_URL);
        sourceId = getIntent().getStringExtra(EXTRA_SOURCE_ID);
        itemType = getIntent().getStringExtra(EXTRA_ITEM_TYPE);
        itemId = getIntent().getStringExtra(EXTRA_ITEM_ID);
        resumeSeconds = getIntent().getIntExtra(EXTRA_RESUME_SECONDS, 0);
        subKey = subKeyFor(itemType, itemId);
        if (url == null || url.isEmpty()) { finish(); return; }
        originalUrl = url;
        streamHost = hostOf(url);
        fallbackUrl = getIntent().getStringExtra(EXTRA_FALLBACK_URL);
        isLocal = getIntent().getBooleanExtra(EXTRA_LOCAL, false);

        playerView = new PlayerView(this);
        // Black everywhere behind the video so letterbox/pillarbox and any
        // cutout-safe insets read as clean black bars, never the theme's grey.
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        playerView.setBackgroundColor(Color.BLACK);
        playerView.setShutterBackgroundColor(Color.BLACK);

        // Root = player + a centered error overlay, so a failed stream shows the
        // real reason on screen instead of hanging silently at 00:00.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.addView(playerView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // Recoverable error panel: a headline + the diagnostic detail + Retry/Back,
        // so a failed stream is a recoverable moment instead of a silent 00:00 hang.
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(32), dp(32), dp(32), dp(32));
        errorPanel.setVisibility(View.GONE);

        TextView errorTitle = new TextView(this);
        errorTitle.setText(getString(R.string.player_error_title));
        errorTitle.setTextColor(Color.WHITE);
        errorTitle.setTextSize(20);
        errorTitle.setGravity(Gravity.CENTER);
        errorTitle.setPadding(0, 0, 0, dp(12));
        errorPanel.addView(errorTitle);

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#cbd5e1"));
        errorView.setTextSize(13);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(0, 0, 0, dp(24));
        errorPanel.addView(errorView);

        Button retryBtn = new Button(this);
        retryBtn.setText(getString(R.string.player_retry));
        retryBtn.setTextColor(Color.WHITE);
        retryBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        retryBtn.setOnClickListener(v -> retryPlayback());
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(dp(220),
                LinearLayout.LayoutParams.WRAP_CONTENT);
        retryLp.bottomMargin = dp(12);
        errorPanel.addView(retryBtn, retryLp);

        Button backBtn = new Button(this);
        backBtn.setText(getString(R.string.player_back));
        backBtn.setTextColor(Color.WHITE);
        backBtn.setBackgroundColor(Color.parseColor("#272d3a"));
        backBtn.setOnClickListener(v -> finish());
        errorPanel.addView(backBtn, new LinearLayout.LayoutParams(dp(220),
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(errorPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        setContentView(root);

        // Fullscreen video that respects display cutouts (notches): draw
        // edge-to-edge under the cutout, hide the system bars, but pad the
        // player by the cutout's safe insets so the media3 controls (title,
        // seek bar, buttons) are never hidden behind a notch or the nav bar.
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        playerView.setOnApplyWindowInsetsListener((v, insets) -> {
            int l = 0, t = 0, r = 0, b = 0;
            if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                DisplayCutout dc = insets.getDisplayCutout();
                l = dc.getSafeInsetLeft();
                t = dc.getSafeInsetTop();
                r = dc.getSafeInsetRight();
                b = dc.getSafeInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        playerView.requestApplyInsets();
        applyImmersive();

        DataSource.Factory dataSourceFactory;
        if (isLocal) {
            // Offline: decrypt the AES/CTR file with the keystore-protected key.
            try {
                byte[] dataKey = DownloadCrypto.unwrapDataKey(
                        DownloadCrypto.unb64(getIntent().getStringExtra(EXTRA_WRAPPED_KEY)),
                        DownloadCrypto.unb64(getIntent().getStringExtra(EXTRA_KEY_IV)));
                byte[] mediaIv = DownloadCrypto.unb64(getIntent().getStringExtra(EXTRA_MEDIA_IV));
                dataSourceFactory = new EncryptedFileDataSource.Factory(dataKey, mediaIv);
            } catch (Exception e) {
                Toast.makeText(this, "Cannot open download", Toast.LENGTH_LONG).show();
                finish();
                return;
            }
        } else {
            DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                    .setUserAgent(UA)
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(30000);
            // Bound open-ended seek ranges so Resume jumps straight to the offset
            // instead of the provider replaying the file from byte 0 (a ~20s stall).
            dataSourceFactory = new BoundedRangeDataSource.Factory(http);
        }

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))
                // Symmetric ±10s so the controller's rewind/fast-forward and the
                // double-tap gesture both jump a predictable, equal amount.
                .setSeekBackIncrementMs(10_000)
                .setSeekForwardIncrementMs(10_000)
                .build();
        playerView.setPlayer(player);
        playerView.setKeepScreenOn(true);
        playerView.setShowSubtitleButton(true);
        installGestureOverlay();
        // Re-apply the viewer's last subtitle choice for this title before the
        // first track selection, so it doesn't reset to the stream default.
        applySavedSubtitlePref();

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    // Arm the "no data" watchdog: a stream that connects but never
                    // delivers playable bytes would otherwise sit at 00:00 forever.
                    errHandler.removeCallbacks(bufferWatchdog);
                    errHandler.postDelayed(bufferWatchdog, BUFFER_TIMEOUT_MS);
                }
                if (state == Player.STATE_READY) {
                    errHandler.removeCallbacks(bufferWatchdog);
                    if (errorPanel != null) errorPanel.setVisibility(View.GONE);
                    if (!resumeApplied && resumeSeconds > 0) {
                        resumeApplied = true;
                        long target = resumeSeconds * 1000L;
                        long duration = player.getDuration();
                        if (duration <= 0 || target < duration - 5000) {
                            player.seekTo(target);
                        }
                    }
                }
                if (state == Player.STATE_ENDED) {
                    errHandler.removeCallbacks(bufferWatchdog);
                    finish();
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                errHandler.removeCallbacks(bufferWatchdog);
                // Direct provider play can be refused for this device's residential IP
                // (e.g. HTTP 401/403) or unreachable, while the cloud gateway IP is
                // accepted. Switch to the gateway fallback once before surfacing the error.
                if (fallbackUrl != null && !fallbackUrl.isEmpty() && !fallbackTried && isIoError(error)) {
                    switchToFallback();
                    return;
                }
                // Surface the real failure on screen (error code, HTTP status, cause,
                // host) instead of a silent hang — so it can be read/screenshotted.
                showStreamError(diagnose(error));
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                // Remember whatever subtitle track ends up showing (or Off) so the
                // next launch of this title restores it.
                persistCurrentSubtitleSelection(tracks);
            }
        });

        MediaItem.Builder mediaItem = new MediaItem.Builder().setUri(url);
        if (isLocal) {
            // The file extension is hidden (.enc); give ExoPlayer a MIME hint so
            // it picks the right extractor (it also sniffs the decrypted bytes).
            String mime = mimeForContainer(getIntent().getStringExtra(EXTRA_CONTAINER));
            if (mime != null) mediaItem.setMimeType(mime);
        }
        originalMediaItem = mediaItem.build();
        player.setMediaItem(originalMediaItem);
        player.prepare();
        player.setPlayWhenReady(true);
    }

    /** Map a download's container extension to a MIME type for the extractor. */
    private static String mimeForContainer(String container) {
        if (container == null) return null;
        switch (container.toLowerCase()) {
            case "mp4":
            case "m4v":
            case "mov":
                return MimeTypes.VIDEO_MP4;
            case "mkv":
            case "webm":
                return MimeTypes.VIDEO_MATROSKA;
            case "ts":
                return MimeTypes.VIDEO_MP2T;
            default:
                return null;
        }
    }

    // ==================== Subtitle preference ====================
    // Remember the viewer's subtitle choice per title so it survives reopening,
    // matched by language (track order can change between plays) with an explicit
    // Off sentinel. Mirrors the web player's per-title subtitle preference.

    private static final String SUB_PREFS = "norva_subprefs";
    private static final String SUB_OFF = "__off__";
    private static final String SUB_ON = "__on__"; // a selected track with no language tag

    private static String subKeyFor(String itemType, String itemId) {
        if (itemId == null || itemId.isEmpty()) return null;
        return (itemType == null || itemType.isEmpty() ? "movie" : itemType) + ":" + itemId;
    }

    private String loadSubPref() {
        if (subKey == null) return null;
        try {
            String v = getSharedPreferences(SUB_PREFS, MODE_PRIVATE).getString(subKey, null);
            return (v == null || v.isEmpty()) ? null : v;
        } catch (Exception e) {
            return null;
        }
    }

    private void saveSubPref(String value) {
        if (subKey == null || value == null) return;
        try {
            getSharedPreferences(SUB_PREFS, MODE_PRIVATE).edit().putString(subKey, value).apply();
        } catch (Exception ignored) { /* preference is best-effort */ }
    }

    /** Bias track selection toward the saved subtitle language (or Off) for this title. */
    private void applySavedSubtitlePref() {
        String pref = loadSubPref();
        if (pref == null || player == null) return;
        if (SUB_OFF.equals(pref)) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
        } else if (!SUB_ON.equals(pref)) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setPreferredTextLanguage(pref).build());
        }
    }

    /** Persist whichever subtitle track is currently selected (or Off) for this title. */
    private void persistCurrentSubtitleSelection(Tracks tracks) {
        if (subKey == null || tracks == null) return;
        boolean hasText = false, selected = false;
        String lang = null;
        for (Tracks.Group g : tracks.getGroups()) {
            if (g.getType() != C.TRACK_TYPE_TEXT) continue;
            hasText = true;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSelected(i)) continue;
                selected = true;
                Format f = g.getTrackFormat(i);
                if (f.language != null && !"und".equals(f.language)) lang = f.language;
            }
        }
        if (selected) saveSubPref(lang != null ? lang : SUB_ON);
        else if (hasText) saveSubPref(SUB_OFF);
        // No text tracks at all: leave any existing preference untouched.
    }

    // ==================== Error display ====================

    private void showStreamError(String message) {
        if (errorView == null || errorPanel == null) return;
        errorView.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        errorPanel.bringToFront();
    }

    /** Re-prepare from the original URL after the user taps Retry on the error panel. */
    private void retryPlayback() {
        if (player == null) return;
        fallbackTried = false;
        errHandler.removeCallbacks(bufferWatchdog);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        streamHost = hostOf(originalUrl);
        player.setMediaItem(originalMediaItem != null
                ? originalMediaItem : new MediaItem.Builder().setUri(originalUrl).build());
        player.prepare();
        player.setPlayWhenReady(true);
    }

    /** Reload from the gateway fallback URL after a direct-URL refusal (e.g. provider 401). */
    private void switchToFallback() {
        fallbackTried = true;
        streamHost = hostOf(fallbackUrl);
        errHandler.removeCallbacks(bufferWatchdog);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        player.setMediaItem(new MediaItem.Builder().setUri(fallbackUrl).build());
        player.prepare();
        player.setPlayWhenReady(true);
    }

    private static boolean isIoError(PlaybackException e) {
        int code = e.errorCode;
        return code >= PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                && code < PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED;
    }

    /** Compact, shareable diagnostic from a playback failure (code, HTTP status, cause, host). */
    @OptIn(markerClass = UnstableApi.class)
    private String diagnose(PlaybackException e) {
        StringBuilder sb = new StringBuilder("Playback failed\n");
        sb.append("Code: ").append(e.getErrorCodeName());
        Throwable c = e.getCause();
        int depth = 0;
        while (c != null && depth < 3) {
            if (c instanceof HttpDataSource.InvalidResponseCodeException) {
                sb.append("\nHTTP ").append(((HttpDataSource.InvalidResponseCodeException) c).responseCode);
            }
            sb.append("\n← ").append(c.getClass().getSimpleName());
            String cm = c.getMessage();
            if (cm != null && !cm.isEmpty()) {
                sb.append(": ").append(cm.length() > 160 ? cm.substring(0, 160) : cm);
            }
            c = c.getCause();
            depth++;
        }
        if (streamHost != null && !streamHost.isEmpty()) sb.append("\nHost: ").append(streamHost);
        return sb.toString();
    }

    private static String hostOf(String url) {
        try { return android.net.Uri.parse(url).getHost(); } catch (Exception e) { return null; }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ==================== Touch gestures ====================

    /**
     * Double-tap the left/right half to seek -/+10s; a single tap toggles the
     * controls. The gesture View lives in the PlayerView overlay (below the media3
     * controller), so when the controller is showing, its buttons still receive
     * touches normally — the overlay only handles taps while the controls are hidden.
     */
    @OptIn(markerClass = UnstableApi.class)
    private void installGestureOverlay() {
        final FrameLayout overlay = playerView.getOverlayFrameLayout();
        if (overlay == null) return;

        seekBubble = new TextView(this);
        seekBubble.setTextColor(Color.WHITE);
        seekBubble.setTextSize(18);
        seekBubble.setBackgroundColor(Color.parseColor("#99000000"));
        seekBubble.setPadding(dp(16), dp(8), dp(16), dp(8));
        seekBubble.setVisibility(View.GONE);

        final GestureDetector detector = new GestureDetector(this,
                new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent e) { return true; }

            @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                if (playerView.isControllerFullyVisible()) playerView.hideController();
                else playerView.showController();
                return true;
            }

            @Override public boolean onDoubleTap(MotionEvent e) {
                if (player == null) return false;
                boolean forward = e.getX() > overlay.getWidth() / 2f;
                player.seekTo(Math.max(0, player.getCurrentPosition() + (forward ? 10_000 : -10_000)));
                showSeekFeedback(forward ? "+10s" : "-10s");
                return true;
            }
        });

        View touchLayer = new View(this);
        touchLayer.setOnTouchListener((v, ev) -> {
            boolean handled = detector.onTouchEvent(ev);
            if (ev.getAction() == MotionEvent.ACTION_UP) v.performClick();
            return handled;
        });
        overlay.addView(touchLayer, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        overlay.addView(seekBubble, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
    }

    /** Flash a "+10s" / "-10s" bubble for ~0.65s after a double-tap seek. */
    private void showSeekFeedback(String text) {
        if (seekBubble == null) return;
        seekBubble.setText(text);
        seekBubble.setVisibility(View.VISIBLE);
        seekBubble.removeCallbacks(hideSeekBubble);
        seekBubble.postDelayed(hideSeekBubble, 650);
    }

    /** Immersive fullscreen: hide the status and navigation bars (sticky, so a
     *  swipe reveals them transiently without resizing the video). */
    private void applyImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /**
     * Hand the final position back to MainActivity, which persists it to the
     * cloud history for cross-device resume. Runs on every exit path.
     */
    @Override
    public void finish() {
        try {
            if (player != null && itemId != null && !itemId.isEmpty()) {
                long pos = Math.max(0, player.getCurrentPosition() / 1000);
                long dur = player.getDuration() > 0 ? player.getDuration() / 1000 : 0;
                if (isLocal) {
                    // Offline: persist the resume point back to the download manifest so
                    // the next offline play picks up where this one left off (the download
                    // id is sourceId:itemId, mirroring MainActivity.startDownload).
                    try {
                        String id = (sourceId == null ? "" : sourceId) + ":" + itemId;
                        DownloadStore.Item it = DownloadStore.get(this, id);
                        if (it != null) { it.positionSeconds = (int) pos; DownloadStore.put(this, it); }
                    } catch (Exception ignored) { /* resume point is best-effort */ }
                }
                Intent data = new Intent();
                data.putExtra("sourceId", sourceId);
                data.putExtra("itemType", itemType);
                data.putExtra("itemId", itemId);
                data.putExtra("positionSeconds", pos);
                data.putExtra("durationSeconds", dur);
                setResult(RESULT_OK, data);
            }
        } catch (Exception ignored) { /* result is best-effort */ }
        super.finish();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        errHandler.removeCallbacks(bufferWatchdog);
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }
}
