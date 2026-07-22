package tv.norva.phone;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Rational;
import android.view.DisplayCutout;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.ScaleGestureDetector;
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
import androidx.annotation.RequiresApi;
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
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.google.firebase.analytics.FirebaseAnalytics;

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
    // Live quality variants: JSON array of {label, streamId, sourceId} for the same
    // logical channel + the currently-playing streamId. Present only for multi-variant
    // live; drives the "Version" button. Picking one returns selectedVariantStreamId to
    // MainActivity, which asks the web to re-resolve + relaunch (one gateway slot → no
    // in-place source swap).
    public static final String EXTRA_VARIANTS = "variants";
    public static final String EXTRA_ACTIVE_VARIANT = "activeStreamId";
    // Ephemeral bearer (user session or paired-device token) used once to post
    // authoritative first-frame truth. PlayerActivity is non-exported.
    public static final String EXTRA_PLAYBACK_AUTH_TOKEN = "playbackAuthToken";

    // IPTV providers gate on User-Agent and REJECT a browser UA (this provider 401s
    // it). Use the VLC UA the relay/gateway use successfully — the working default
    // for the whole stack (the cloud sends no UA, so the relay falls back to VLC).
    private static final String UA = "VLC/3.0.20 LibVLC/3.0.20";

    private ExoPlayer player;
    private MediaSession mediaSession;   // lock-screen / media-button transport controls
    private PlayerView playerView;
    private LinearLayout errorPanel;     // recoverable error UI (message + Retry + Back)
    private TextView errorView;          // the diagnostic detail line inside errorPanel
    private String streamHost;           // host of the stream URL, included in the error text
    private String originalUrl;          // the first URL we tried, used to re-prepare on Retry
    private MediaItem originalMediaItem; // built once, replayed on Retry (carries the local MIME hint)
    private boolean isLocal = false;     // offline (encrypted local file) playback
    private String fallbackUrl;          // gateway URL to retry with on a direct-URL refusal
    private boolean fallbackTried = false;
    private int playRetries = 0;          // one in-place reconnect before asking JS for a fresh session
    private int recoveryGeneration = 0;   // invalidates delayed reconnects after a newer recovery action
    private boolean everReady = false;    // direct or fallback reached STATE_READY at least once
    private boolean firstFrameRendered = false;
    private long playbackLaunchElapsedMs;
    private String playbackAuthToken;
    private boolean freshStreamRequested = false;
    private String freshStreamReason;
    private String sourceId;
    private String itemType;
    private String itemId;
    private String subKey; // SharedPreferences key for the per-title subtitle choice
    // H1 fix: the native player otherwise reports position only on a graceful
    // online finish(), so backgrounding/standby/kill (and ALL offline playback,
    // which is launched without a result) loses the position. We persist it to
    // SharedPreferences on onPause/onStop/onUserLeaveHint; MainActivity flushes any
    // pending position to cloud history on its next foreground.
    private boolean gracefulResultEmitted = false;
    private int resumeSeconds = 0;
    private boolean resumeApplied = false;
    private boolean endedNaturally = false;   // reached STATE_ENDED → web autoplays next episode
    private TextView seekBubble;         // transient "+10s" / "🔆 60%" gesture feedback
    private final Runnable hideSeekBubble = new Runnable() {
        @Override public void run() { if (seekBubble != null) seekBubble.setVisibility(View.GONE); }
    };
    // Vertical-drag gesture state: 0 none, 1 brightness (left half), 2 volume (right half)
    private int verticalDragMode = 0;
    private float gestureStartBrightness = 0.5f;
    private int gestureStartVolume = 0;

    // PiP transport actions (play/pause buttons on the mini window).
    private static final String ACTION_PIP_CONTROL = "tv.norva.phone.PIP_CONTROL";
    private static final String EXTRA_PIP_ACTION = "pipAction";
    private BroadcastReceiver pipReceiver;

    // Lock controls: swallow every gesture until explicitly unlocked.
    private boolean controlsLocked = false;
    private Button lockBtn;
    private Button unlockBtn;
    private final Runnable hideUnlockBtn = new Runnable() {
        @Override public void run() { if (unlockBtn != null) unlockBtn.setVisibility(View.GONE); }
    };

    // Pinch-to-zoom: fit <-> zoom (crop) like Netflix.
    private ScaleGestureDetector scaleDetector;
    private float pinchAccum = 1f;

    // Chromecast: discovery + session hand-over (see CastSupport).
    private CastSupport castSupport;
    private android.widget.ImageButton castButton;
    private LinearLayout castBar;
    private TextView castBarLabel;
    private org.json.JSONArray variants;      // live quality variants, null for single-variant/movies
    private String activeStreamId;            // currently-playing variant's streamId
    private String pendingVariantStreamId;    // set when the viewer picks a variant → attached to the result in finish()
    private String pendingVariantSourceId;
    private String mediaTitle;

    private final Handler errHandler = new Handler(Looper.getMainLooper());
    private static final long BUFFER_TIMEOUT_MS = 35_000L; // "no data" watchdog
    private static final long HEALTHY_RECOVERY_RESET_MS = 60_000L;
    private final Runnable healthyRecoveryReset = new Runnable() {
        @Override public void run() { playRetries = 0; }
    };
    // A stream that connects but never delivers playable bytes throws NO
    // PlaybackException, so it never reaches the onPlayerError recovery ladder. Drive
    // the same recovery here: switch to the gateway fallback once, then a single
    // re-prepare (the provider frees its lone slot ~8s after the prior drop), and only
    // then surface the error — instead of dead-ending at the message.
    private final Runnable bufferWatchdog = new Runnable() {
        @Override
        public void run() {
            recoverPlayback("no_data_timeout");
        }
    };

    @OptIn(markerClass = UnstableApi.class)
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        playbackLaunchElapsedMs = SystemClock.elapsedRealtime();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url = getIntent().getStringExtra(EXTRA_URL);
        mediaTitle = getIntent().getStringExtra(EXTRA_TITLE);
        sourceId = getIntent().getStringExtra(EXTRA_SOURCE_ID);
        itemType = getIntent().getStringExtra(EXTRA_ITEM_TYPE);
        itemId = getIntent().getStringExtra(EXTRA_ITEM_ID);
        playbackAuthToken = getIntent().getStringExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        getIntent().removeExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        resumeSeconds = getIntent().getIntExtra(EXTRA_RESUME_SECONDS, 0);
        subKey = subKeyFor(itemType, itemId);
        if (url == null || url.isEmpty()) { finish(); return; }
        originalUrl = url;
        streamHost = hostOf(url);
        fallbackUrl = getIntent().getStringExtra(EXTRA_FALLBACK_URL);
        isLocal = getIntent().getBooleanExtra(EXTRA_LOCAL, false);
        activeStreamId = getIntent().getStringExtra(EXTRA_ACTIVE_VARIANT);
        try {
            String vj = getIntent().getStringExtra(EXTRA_VARIANTS);
            if (vj != null && !vj.isEmpty()) {
                org.json.JSONArray arr = new org.json.JSONArray(vj);
                if (arr.length() > 1) variants = arr;
            }
        } catch (Exception ignored) { variants = null; }

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
                // Use the bundled FFmpeg software audio decoder (AC-3/E-AC-3/DTS/
                // TrueHD) as a FALLBACK after the device's MediaCodec, so offline
                // downloads with Dolby/DTS audio still play on phones whose hardware
                // lacks those decoders. EXTENSION_RENDERER_MODE_ON keeps hardware
                // decoders first and only falls back to FFmpeg when needed. This is
                // a no-op until the decoder .aar is dropped in app/libs/:
                // DefaultRenderersFactory loads FfmpegAudioRenderer by reflection and
                // silently skips it when absent. (See clients/android-ffmpeg-decoder.)
                .setRenderersFactory(new DefaultRenderersFactory(this)
                        .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON))
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))
                // Symmetric ±10s so the controller's rewind/fast-forward and the
                // double-tap gesture both jump a predictable, equal amount.
                .setSeekBackIncrementMs(10_000)
                .setSeekForwardIncrementMs(10_000)
                .build();
        playerView.setPlayer(player);
        // Bind a MediaSession so hardware/Bluetooth media buttons and the system
        // media controls (lock screen / notification shade) drive this player.
        try { mediaSession = new MediaSession.Builder(this, player).build(); } catch (Exception ignored) { }
        // PiP transport: the mini window's play/pause button broadcasts back here.
        pipReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                if (!ACTION_PIP_CONTROL.equals(intent.getAction()) || player == null) return;
                if ("pause".equals(intent.getStringExtra(EXTRA_PIP_ACTION))) player.pause();
                else player.play();
                refreshPipActions();
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(pipReceiver, new IntentFilter(ACTION_PIP_CONTROL), Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(pipReceiver, new IntentFilter(ACTION_PIP_CONTROL));
            }
        } catch (Exception ignored) { pipReceiver = null; }
        playerView.setKeepScreenOn(true);
        playerView.setShowSubtitleButton(true);
        installGestureOverlay();
        // Chromecast: the receiver fetches the provider URL itself from the same
        // home network. Local (encrypted) downloads can't be cast.
        if (!isLocal) installCastSupport(root);
        installVariantControl(root);
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
                    everReady = true;
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
                    if (isPrematureEnd()) {
                        recoverPlayback(isLiveContent() ? "live_eof" : "premature_eof");
                    } else {
                        endedNaturally = true;
                        finish();
                    }
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                errHandler.removeCallbacks(bufferWatchdog);
                // Direct provider play can be refused for this device's residential IP
                // (e.g. HTTP 401/403) or unreachable, while the cloud gateway IP is
                // accepted. A single-slot panel can also answer "busy" with a non-media
                // body on HTTP 200, which surfaces here as a PARSING_CONTAINER_* error —
                // slot contention, not a broken file (2026-07-18 VOD incident). Both are
                // recoverable: drive the same ladder as the watchdog — gateway fallback
                // once, then one delayed re-prepare (the provider frees its lone slot
                // ~8s after the prior drop), and only then surface the error.
                if (isRecoverableError(error)) {
                    recoverPlayback(error.getErrorCodeName());
                    return;
                }
                // Surface the real failure on screen (error code, HTTP status, cause,
                // host) instead of a silent hang — so it can be read/screenshotted.
                showStreamError(diagnose(error));
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                errHandler.removeCallbacks(healthyRecoveryReset);
                if (isPlaying) {
                    errHandler.postDelayed(healthyRecoveryReset, HEALTHY_RECOVERY_RESET_MS);
                }
                refreshPipActions(); // keep the PiP button icon in sync
            }

            @Override
            public void onRenderedFirstFrame() {
                if (!firstFrameRendered) {
                    firstFrameRendered = true;
                    recordNativeFirstFrame();
                }
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

    /** Device-side truth that media actually rendered, emitted once per launch. */
    private void recordNativeFirstFrame() {
        final String authToken = playbackAuthToken;
        playbackAuthToken = null;
        NativePlaybackTelemetry.recordFirstFrame(authToken, sourceId, itemType, itemId,
                Math.max(1L, SystemClock.elapsedRealtime() - playbackLaunchElapsedMs), isLocal);
        try {
            Bundle event = new Bundle();
            event.putString("content_type",
                    itemType == null || itemType.isEmpty() ? "unknown" : itemType);
            if (itemId != null && !itemId.isEmpty()) event.putString("item_id", itemId);
            if (sourceId != null && !sourceId.isEmpty()) event.putString("source_id", sourceId);
            event.putLong("ttff_ms", Math.max(0L,
                    SystemClock.elapsedRealtime() - playbackLaunchElapsedMs));
            event.putString("playback_mode", isLocal ? "offline" : "stream");
            FirebaseAnalytics.getInstance(this).logEvent("native_first_frame", event);
        } catch (Throwable ignored) {
            // Measurement must never affect playback.
        }
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

    /** A manual retry must resolve a new provider/Gateway session, not reuse a stale signed URL. */
    private void retryPlayback() {
        requestFreshStream("manual_retry");
    }

    private boolean isLiveContent() {
        return "channel".equals(itemType) || "live".equals(itemType);
    }

    /**
     * A provider EOF is never a natural end for live. For VOD, require at least
     * one rendered frame and a position close to the declared duration before
     * marking the title watched or returning an ended result to the web layer.
     */
    private boolean isPrematureEnd() {
        if (isLiveContent()) return true;
        if (!firstFrameRendered || player == null) return true;
        long duration = player.getDuration();
        long position = Math.max(0, player.getCurrentPosition());
        // An unknown duration makes EOF ambiguous: recover instead of marking
        // the title watched or advancing a series incorrectly.
        if (duration <= 0 || duration == C.TIME_UNSET) return true;
        return position < duration - 30_000L && position < Math.round(duration * 0.97d);
    }

    /** Preserve the current VOD position across direct/fallback reconnects. */
    private long recoverPositionMs() {
        if (player == null || isLiveContent()) return 0L;
        long duration = player.getDuration();
        long position = Math.max(0, player.getCurrentPosition());
        return duration > 0
                ? Math.min(position, Math.max(0, duration - 1_000L))
                : position;
    }

    /**
     * Recover without ejecting the viewer: retry the proven current route once,
     * then try the Gateway fallback, then ask the web layer to resolve a brand-new
     * session. The retry budget resets only after 60 seconds of healthy playback,
     * preventing rapid READY/EOF loops from retrying forever.
     */
    private void recoverPlayback(final String reason) {
        if (player == null || freshStreamRequested) return;
        final int scheduledGeneration = ++recoveryGeneration;
        errHandler.removeCallbacks(bufferWatchdog);
        errHandler.removeCallbacks(healthyRecoveryReset);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);

        // A startup failure never proved the residential route healthy, so move
        // to the supplied Gateway fallback immediately. Mid-stream, reconnect the
        // already-good route once before moving traffic to the datacenter.
        if (!everReady && !fallbackTried && fallbackUrl != null && !fallbackUrl.isEmpty()) {
            switchToFallback();
            return;
        }
        if (playRetries < 1) {
            playRetries++;
            final MediaItem current = player.getCurrentMediaItem();
            final long position = recoverPositionMs();
            errHandler.postDelayed(new Runnable() {
                @Override public void run() {
                    if (player == null || freshStreamRequested
                            || scheduledGeneration != recoveryGeneration) return;
                    MediaItem item = current != null ? current : new MediaItem.Builder()
                            .setUri(fallbackTried && fallbackUrl != null ? fallbackUrl : originalUrl)
                            .build();
                    player.setMediaItem(item, position);
                    player.prepare();
                    player.setPlayWhenReady(true);
                }
            }, 1_500L);
            return;
        }
        if (!fallbackTried && fallbackUrl != null && !fallbackUrl.isEmpty()) {
            switchToFallback();
            return;
        }
        requestFreshStream(reason);
    }

    /** Hand exhausted playback back to the WebView for a fresh provider resolution. */
    private void requestFreshStream(String reason) {
        if (freshStreamRequested) return;
        recoveryGeneration++;
        if (isLocal || sourceId == null || sourceId.isEmpty()
                || itemId == null || itemId.isEmpty()) {
            showStreamError(getString(R.string.player_no_data)
                    + (streamHost != null ? "\nHost: " + streamHost : ""));
            return;
        }
        freshStreamRequested = true;
        freshStreamReason = reason == null ? "playback_interrupted" : reason;
        showStreamError("Reconnecting\u2026");
        errHandler.postDelayed(new Runnable() {
            @Override public void run() {
                if (!isFinishing()) finish();
            }
        }, 350L);
    }

    /** Reload from the gateway fallback URL after a direct-URL refusal (e.g. provider 401). */
    private void switchToFallback() {
        recoveryGeneration++;
        fallbackTried = true;
        playRetries = 0;              // one fresh in-place retry budget for the fallback URL
        streamHost = hostOf(fallbackUrl);
        errHandler.removeCallbacks(bufferWatchdog);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        player.setMediaItem(new MediaItem.Builder().setUri(fallbackUrl).build(), recoverPositionMs());
        player.prepare();
        player.setPlayWhenReady(true);
    }

    /**
     * IO errors (network/HTTP refusals) AND container/manifest parsing errors are
     * worth the recovery ladder. On single-slot IPTV accounts a "busy"/ban refusal
     * often arrives as a non-media body on HTTP 200, which ExoPlayer reports as an
     * unparseable container — contention wearing a parsing error's clothes. Decode,
     * DRM and codec errors stay non-recoverable (retrying can't fix those).
     */
    private static boolean isRecoverableError(PlaybackException e) {
        int code = e.errorCode;
        return code >= PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                && code <= PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED;
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
     * Touch gestures on the video surface (Netflix parity):
     *   - single tap toggles the controls,
     *   - double-tap left/right half seeks -/+10s,
     *   - vertical drag on the LEFT half adjusts screen brightness,
     *   - vertical drag on the RIGHT half adjusts media volume.
     * The gesture View lives in the PlayerView overlay (below the media3
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

        final android.media.AudioManager audio =
                (android.media.AudioManager) getSystemService(AUDIO_SERVICE);

        final GestureDetector detector = new GestureDetector(this,
                new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent e) {
                // Anchor the drag: current brightness/volume become the baseline.
                gestureStartBrightness = getWindow().getAttributes().screenBrightness;
                if (gestureStartBrightness < 0) {
                    // "System default" — read the actual setting so the first drag
                    // starts from what the user sees, not from an arbitrary jump.
                    try {
                        gestureStartBrightness = android.provider.Settings.System.getInt(
                                getContentResolver(),
                                android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f;
                    } catch (Exception ex) {
                        gestureStartBrightness = 0.5f;
                    }
                }
                gestureStartVolume = audio == null ? 0
                        : audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
                verticalDragMode = 0;
                return true;
            }

            @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                if (controlsLocked) { flashUnlockButton(); return true; }
                if (playerView.isControllerFullyVisible()) playerView.hideController();
                else playerView.showController();
                return true;
            }

            @Override public boolean onDoubleTap(MotionEvent e) {
                if (player == null || controlsLocked) return false;
                boolean forward = e.getX() > overlay.getWidth() / 2f;
                player.seekTo(Math.max(0, player.getCurrentPosition() + (forward ? 10_000 : -10_000)));
                showSeekFeedback(forward ? "+10s" : "-10s");
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                if (e1 == null || e2 == null) return false;
                float totalDy = e1.getY() - e2.getY(); // up = positive
                float totalDx = Math.abs(e2.getX() - e1.getX());
                // Engage only on a clearly vertical drag, and never over the
                // controller (its buttons/seek bar own touches when visible).
                if (controlsLocked || (scaleDetector != null && scaleDetector.isInProgress())) return false;
                if (verticalDragMode == 0) {
                    if (Math.abs(totalDy) < dp(24) || totalDx > Math.abs(totalDy)) return false;
                    if (playerView.isControllerFullyVisible()) return false;
                    verticalDragMode = e1.getX() < overlay.getWidth() / 2f ? 1 : 2;
                }
                float range = overlay.getHeight() * 0.75f; // full swipe ≈ full scale
                if (verticalDragMode == 1) {
                    float b = Math.max(0.02f, Math.min(1f, gestureStartBrightness + totalDy / range));
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = b;
                    getWindow().setAttributes(lp);
                    showSeekFeedback("🔆 " + Math.round(b * 100) + "%");
                } else if (audio != null) {
                    int max = audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC);
                    int v = Math.round(Math.max(0, Math.min(max,
                            gestureStartVolume + (totalDy / range) * max)));
                    audio.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, v, 0);
                    showSeekFeedback("🔊 " + Math.round(v * 100f / max) + "%");
                }
                return true;
            }
        });

        // Pinch: fit <-> zoom (crop). Cumulative factor decided on gesture end so a
        // wobbly pinch doesn't flip modes mid-gesture.
        scaleDetector = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override public boolean onScale(ScaleGestureDetector d) { pinchAccum *= d.getScaleFactor(); return true; }
            @Override public void onScaleEnd(ScaleGestureDetector d) {
                if (!controlsLocked) {
                    if (pinchAccum > 1.15f) {
                        playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
                        showSeekFeedback("Zoom");
                    } else if (pinchAccum < 0.87f) {
                        playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
                        showSeekFeedback("Fit");
                    }
                }
                pinchAccum = 1f;
            }
        });

        View touchLayer = new View(this);
        touchLayer.setOnTouchListener((v, ev) -> {
            scaleDetector.onTouchEvent(ev);
            boolean handled = detector.onTouchEvent(ev);
            if (ev.getAction() == MotionEvent.ACTION_UP) {
                verticalDragMode = 0;
                v.performClick();
            }
            return handled;
        });
        overlay.addView(touchLayer, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        overlay.addView(seekBubble, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        // Lock controls: shown alongside the controller; when locked, every
        // gesture is swallowed and only the transient unlock pill responds.
        lockBtn = new Button(this);
        lockBtn.setText("\uD83D\uDD12 Lock");
        lockBtn.setTextColor(Color.WHITE);
        lockBtn.setBackgroundColor(Color.parseColor("#66000000"));
        lockBtn.setOnClickListener(v -> setControlsLocked(true));
        FrameLayout.LayoutParams lockLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.START);
        lockLp.topMargin = dp(20);
        lockLp.leftMargin = dp(20);
        overlay.addView(lockBtn, lockLp);
        playerView.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) visibility ->
                lockBtn.setVisibility(visibility == View.VISIBLE && !controlsLocked ? View.VISIBLE : View.GONE));
        lockBtn.setVisibility(View.GONE);

        unlockBtn = new Button(this);
        unlockBtn.setText("\uD83D\uDD13 Unlock");
        unlockBtn.setTextColor(Color.WHITE);
        unlockBtn.setBackgroundColor(Color.parseColor("#99000000"));
        unlockBtn.setVisibility(View.GONE);
        unlockBtn.setOnClickListener(v -> setControlsLocked(false));
        FrameLayout.LayoutParams unlockLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        unlockLp.topMargin = dp(28);
        overlay.addView(unlockBtn, unlockLp);
    }

    private void setControlsLocked(boolean locked) {
        controlsLocked = locked;
        playerView.setUseController(!locked);
        if (locked) {
            playerView.hideController();
            lockBtn.setVisibility(View.GONE);
            flashUnlockButton();
        } else {
            unlockBtn.removeCallbacks(hideUnlockBtn);
            unlockBtn.setVisibility(View.GONE);
            playerView.showController();
        }
    }

    /** While locked, a tap reveals the unlock pill for a few seconds. */
    private void flashUnlockButton() {
        if (unlockBtn == null) return;
        unlockBtn.setVisibility(View.VISIBLE);
        unlockBtn.removeCallbacks(hideUnlockBtn);
        unlockBtn.postDelayed(hideUnlockBtn, 3000);
    }

    // ==================== Chromecast ====================

    /**
     * Cast button (top-right, shown when devices are on the network) + a
     * "Diffusion sur X" banner while a session is active. The local player
     * pauses the instant the session starts, so the provider still sees a
     * single connection (the receiver's, from the same home IP).
     */
    /**
     * Live "Version" button (top-left): opens the quality-variant picker. Shown only when
     * the web handed us >1 variant for this channel. Picking one returns it to MainActivity,
     * which asks the web to re-resolve + relaunch that variant (one gateway slot → we can't
     * swap the source in place).
     */
    private void installVariantControl(FrameLayout root) {
        if (variants == null) return;
        Button variantBtn = new Button(this);
        variantBtn.setText(currentVariantLabel() + "  ▾");
        variantBtn.setAllCaps(false);
        variantBtn.setTextColor(Color.WHITE);
        variantBtn.setBackgroundColor(Color.parseColor("#66000000"));
        variantBtn.setContentDescription("Changer la version (qualité)");
        variantBtn.setOnClickListener(v -> showVariantDialog());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.START);
        lp.topMargin = dp(20);
        lp.leftMargin = dp(20);
        root.addView(variantBtn, lp);
    }

    private String currentVariantLabel() {
        if (variants == null) return "Version";
        try {
            for (int i = 0; i < variants.length(); i++) {
                org.json.JSONObject v = variants.optJSONObject(i);
                if (v != null && activeStreamId != null && activeStreamId.equals(v.optString("streamId")))
                    return v.optString("label", "Version");
            }
        } catch (Exception ignored) { }
        return "Version";
    }

    private void showVariantDialog() {
        if (variants == null) return;
        final java.util.List<String> labels = new java.util.ArrayList<>();
        final java.util.List<String> streamIds = new java.util.ArrayList<>();
        final java.util.List<String> sourceIds = new java.util.ArrayList<>();
        int selected = -1;
        try {
            for (int i = 0; i < variants.length(); i++) {
                org.json.JSONObject v = variants.optJSONObject(i);
                if (v == null) continue;
                String sid = v.optString("streamId", "");
                if (sid.isEmpty()) continue;
                labels.add(v.optString("label", "Variant " + (labels.size() + 1)));
                streamIds.add(sid);
                sourceIds.add(v.optString("sourceId", ""));
                if (activeStreamId != null && activeStreamId.equals(sid)) selected = labels.size() - 1;
            }
        } catch (Exception ignored) { }
        if (labels.size() < 2) return;
        new android.app.AlertDialog.Builder(this, android.app.AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Version")
                .setSingleChoiceItems(labels.toArray(new String[0]), selected,
                        new android.content.DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(android.content.DialogInterface dialog, int which) {
                                dialog.dismiss();
                                if (streamIds.get(which).equals(activeStreamId)) return; // already playing
                                // Record the pick as fields; finish() attaches them to the SAME result Intent
                                // it already builds (a direct setResult here would be clobbered by finish()).
                                pendingVariantStreamId = streamIds.get(which);
                                pendingVariantSourceId = sourceIds.get(which);
                                finish(); // MainActivity → web re-resolves + relaunches this variant
                            }
                        })
                .show();
    }

    private void installCastSupport(FrameLayout root) {
        castButton = new android.widget.ImageButton(this);
        castButton.setImageResource(R.drawable.ic_cast);
        castButton.setBackgroundColor(Color.parseColor("#66000000"));
        castButton.setPadding(dp(12), dp(12), dp(12), dp(12));
        castButton.setContentDescription("Diffuser (Chromecast)");
        castButton.setVisibility(View.GONE);
        castButton.setOnClickListener(v -> { if (castSupport != null) castSupport.showRoutePicker(); });
        FrameLayout.LayoutParams btnLp = new FrameLayout.LayoutParams(
                dp(48), dp(48), Gravity.TOP | Gravity.END);
        btnLp.topMargin = dp(20);
        btnLp.rightMargin = dp(20);
        root.addView(castButton, btnLp);

        castBar = new LinearLayout(this);
        castBar.setOrientation(LinearLayout.HORIZONTAL);
        castBar.setGravity(Gravity.CENTER_VERTICAL);
        castBar.setBackgroundColor(Color.parseColor("#CC0A0A0F"));
        castBar.setPadding(dp(20), dp(12), dp(20), dp(12));
        castBar.setVisibility(View.GONE);

        castBarLabel = new TextView(this);
        castBarLabel.setTextColor(Color.WHITE);
        castBarLabel.setTextSize(15);
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        castBar.addView(castBarLabel, labelLp);

        Button pauseBtn = new Button(this);
        pauseBtn.setText("⏯");
        pauseBtn.setTextColor(Color.WHITE);
        pauseBtn.setBackgroundColor(Color.parseColor("#33FFFFFF"));
        pauseBtn.setOnClickListener(v -> { if (castSupport != null) castSupport.toggleRemotePlayback(); });
        LinearLayout.LayoutParams pauseLp = new LinearLayout.LayoutParams(
                dp(56), LinearLayout.LayoutParams.WRAP_CONTENT);
        pauseLp.rightMargin = dp(10);
        castBar.addView(pauseBtn, pauseLp);

        Button stopBtn = new Button(this);
        stopBtn.setText("Arrêter");
        stopBtn.setTextColor(Color.WHITE);
        stopBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        stopBtn.setOnClickListener(v -> { if (castSupport != null) castSupport.endSession(); });
        castBar.addView(stopBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(castBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));

        castSupport = new CastSupport(this, new CastSupport.Listener() {
            @Override
            public void onRouteAvailabilityChanged(boolean available) {
                runOnUiThread(() -> {
                    if (castButton != null) castButton.setVisibility(available ? View.VISIBLE : View.GONE);
                });
            }

            @Override
            public void onCastStarted(String deviceName) {
                runOnUiThread(() -> {
                    long pos = player == null ? 0 : Math.max(0, player.getCurrentPosition());
                    String castUrl = fallbackTried && fallbackUrl != null ? fallbackUrl : originalUrl;
                    boolean live = "channel".equals(itemType);
                    castSupport.loadMedia(castUrl, mediaTitle, null, live ? 0 : pos, live);
                    if (player != null) player.pause();
                    if (castBarLabel != null) castBarLabel.setText("Diffusion sur " + deviceName);
                    if (castBar != null) castBar.setVisibility(View.VISIBLE);
                });
            }

            @Override
            public void onCastEnded(long resumePositionMs) {
                runOnUiThread(() -> {
                    if (castBar != null) castBar.setVisibility(View.GONE);
                    if (player != null) {
                        if (resumePositionMs > 0 && !"channel".equals(itemType)) {
                            player.seekTo(resumePositionMs);
                        }
                        player.play();
                    }
                });
            }
        });
        castSupport.start();
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
     * Persist the live position to SharedPreferences so a non-graceful exit
     * (background/standby/kill) — or any offline play, which is launched without a
     * result — doesn't lose it. Best-effort; skipped once an online finish() has
     * emitted an authoritative result that onActivityResult will relay to cloud.
     */
    private void persistPendingProgress() {
        try {
            if (gracefulResultEmitted) return;
            if (player == null || itemId == null || itemId.isEmpty()) return;
            long pos = Math.max(0, player.getCurrentPosition() / 1000);
            if (pos <= 0) return;
            long dur = player.getDuration() > 0 ? player.getDuration() / 1000 : 0;
            getSharedPreferences("norva_mobile", MODE_PRIVATE).edit()
                    .putString("pending_progress_sourceId", sourceId == null ? "" : sourceId)
                    .putString("pending_progress_itemType", itemType == null ? "" : itemType)
                    .putString("pending_progress_itemId", itemId)
                    .putLong("pending_progress_pos", pos)
                    .putLong("pending_progress_dur", dur)
                    .apply();
        } catch (Exception ignored) { /* best-effort */ }
    }

    private void clearPendingProgress() {
        try {
            getSharedPreferences("norva_mobile", MODE_PRIVATE).edit()
                    .remove("pending_progress_sourceId")
                    .remove("pending_progress_itemType")
                    .remove("pending_progress_itemId")
                    .remove("pending_progress_pos")
                    .remove("pending_progress_dur")
                    .apply();
        } catch (Exception ignored) { }
    }

    @Override
    protected void onStop() {
        super.onStop();
        persistPendingProgress();
    }

    /**
     * Hand the final position back to MainActivity, which persists it to the
     * cloud history for cross-device resume. Runs on every exit path.
     */
    @Override
    public void finish() {
        try {
            Intent data = null;
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
                data = new Intent();
                data.putExtra("sourceId", sourceId);
                data.putExtra("itemType", itemType);
                data.putExtra("itemId", itemId);
                data.putExtra("positionSeconds", pos);
                data.putExtra("durationSeconds", dur);
                data.putExtra("ended", endedNaturally);
            }
            // A variant pick must survive finish() (which would otherwise overwrite the result
            // with the progress-only Intent above, dropping selectedVariantStreamId).
            if (pendingVariantStreamId != null && !pendingVariantStreamId.isEmpty()) {
                if (data == null) data = new Intent();
                data.putExtra("selectedVariantStreamId", pendingVariantStreamId);
                data.putExtra("selectedVariantSourceId", pendingVariantSourceId);
            }
            if (freshStreamRequested) {
                if (data == null) data = new Intent();
                data.putExtra("sourceId", sourceId);
                data.putExtra("itemType", itemType);
                data.putExtra("itemId", itemId);
                data.putExtra("positionSeconds", player == null
                        ? 0L : Math.max(0, player.getCurrentPosition() / 1000));
                data.putExtra("retryPlayback", true);
                data.putExtra("retryReason", freshStreamReason);
            }
            if (data != null) setResult(RESULT_OK, data);
            // Online exits are relayed to cloud by MainActivity.onActivityResult, so
            // drop any pending copy. Offline playback is launched WITHOUT a result
            // (DownloadsActivity.startActivity), so we deliberately keep the pending
            // record — onStop persisted it and MainActivity flushes it to cloud on its
            // next foreground, which is how a downloaded title's progress syncs.
            if (!isLocal) { gracefulResultEmitted = true; clearPendingProgress(); }
        } catch (Exception ignored) { /* result is best-effort */ }
        super.finish();
    }

    @Override
    protected void onPause() {
        super.onPause();
        persistPendingProgress();
        // Keep playing while in Picture-in-Picture; only pause when truly backgrounded.
        boolean inPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode();
        if (player != null && !inPip) player.pause();
    }

    // Picture-in-Picture: when the user leaves (Home / recents) while a video is
    // playing, shrink into a PiP window and keep playing.
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        persistPendingProgress();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (player == null || !player.isPlaying()) return;
        try { enterPictureInPictureMode(buildPipParams()); } catch (Exception ignored) { }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams buildPipParams() {
        Rational ratio = new Rational(16, 9);
        try {
            int w = player.getVideoSize().width;
            int h = player.getVideoSize().height;
            if (w > 0 && h > 0) {
                float r = (float) w / h;
                // Android rejects PiP aspect ratios outside roughly 1:2.39 .. 2.39:1.
                if (r >= 0.42f && r <= 2.39f) ratio = new Rational(w, h);
            }
        } catch (Exception ignored) { }
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(ratio);
        // Transport control on the mini window (Netflix PiP shows play/pause).
        try {
            boolean playing = player != null && player.isPlaying();
            Intent i = new Intent(ACTION_PIP_CONTROL)
                    .setPackage(getPackageName())
                    .putExtra(EXTRA_PIP_ACTION, playing ? "pause" : "play");
            PendingIntent pi = PendingIntent.getBroadcast(this, playing ? 1 : 2, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Icon icon = Icon.createWithResource(this,
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
            b.setActions(java.util.Collections.singletonList(
                    new RemoteAction(icon, playing ? "Pause" : "Play", "Play/Pause", pi)));
        } catch (Exception ignored) { /* actions are optional */ }
        return b.build();
    }

    /** Re-issue the PiP params so the play/pause button reflects the new state. */
    private void refreshPipActions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            if (isInPictureInPictureMode()) setPictureInPictureParams(buildPipParams());
        } catch (Exception ignored) { }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPip, newConfig);
        if (playerView != null) {
            // No transport UI inside the tiny PiP window.
            playerView.setUseController(!isInPip);
            if (isInPip) playerView.hideController();
        }
    }

    @Override
    protected void onDestroy() {
        playbackAuthToken = null;
        errHandler.removeCallbacksAndMessages(null);
        if (pipReceiver != null) { try { unregisterReceiver(pipReceiver); } catch (Exception ignored) { } pipReceiver = null; }
        if (castSupport != null) { castSupport.stop(); castSupport = null; }
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }
}
