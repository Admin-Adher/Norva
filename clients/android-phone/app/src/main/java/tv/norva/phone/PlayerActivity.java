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
import android.widget.RadioButton;
import android.widget.SeekBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
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

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

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
    // Exact-file, fail-closed track metadata from the already-loaded Norva
    // catalogue. This never opens a second provider connection.
    public static final String EXTRA_TRACK_METADATA = "trackMetadata";
    public static final String EXTRA_PREFERENCE_SCOPE = "preferenceScope";
    public static final String EXTRA_PLAYBACK_PREFERENCES = "playbackPreferences";
    public static final String EXTRA_POSTER_URL = "poster";
    public static final String EXTRA_NEXT_TITLE = "nextTitle";
    public static final String ACTION_REQUEST_FRESH_STREAM =
            "tv.norva.phone.action.REQUEST_FRESH_STREAM";
    public static final String ACTION_APPLY_FRESH_STREAM =
            "tv.norva.phone.action.APPLY_FRESH_STREAM";
    public static final String EXTRA_RECOVERY_TOKEN = "recoveryToken";
    public static final String EXTRA_RECOVERY_PAYLOAD = "recoveryPayload";
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
    private String recoveryToken;
    private BroadcastReceiver freshStreamReceiver;
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
    private android.widget.ImageButton lockBtn;
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
    private Button variantButton;
    private LinearLayout castBar;
    private TextView castBarLabel;
    private org.json.JSONArray variants;      // live quality variants, null for single-variant/movies
    private String activeStreamId;            // currently-playing variant's streamId
    private String pendingVariantStreamId;    // set when the viewer picks a variant → attached to the result in finish()
    private String pendingVariantSourceId;
    private String mediaTitle;
    private String posterUrl;
    private String nextTitle;
    private FrameLayout playerRoot;
    private LinearLayout topBar;
    private int safeInsetLeft;
    private int safeInsetTop;
    private int safeInsetRight;
    private int safeInsetBottom;

    // Compact actions injected into Media3's own bottom bar, on the same row as
    // the elapsed/duration labels. The selector remains unified internally, but
    // audio and subtitle icons take viewers directly to the relevant section.
    private android.widget.ImageButton audioButton;
    private android.widget.ImageButton subtitleButton;
    private android.widget.ImageButton resizeButton;
    private android.widget.ImageButton brightnessButton;
    private android.app.AlertDialog trackDialog;
    private org.json.JSONArray verifiedAudioTracks;
    private org.json.JSONArray exactSubtitleTracks;
    private boolean hasBurnedSubtitle;
    private String burnedSubtitleLanguage;
    private boolean hasAudioChoices = false;
    private boolean hasSubtitleChoices = false;
    private String selectedAudioLabel;
    private String selectedSubtitleLabel;
    private String preferenceScopeJson;
    private String cloudPlaybackPreferencesJson;
    private String currentTrackPreferencesJson;
    private boolean trackPreferencesApplied;
    private PlaybackPreferenceStore preferenceStore;
    private PlaybackPreferenceStore.Scope preferenceScope;
    private PlaybackPreferenceStore.Preferences resolvedTrackPreferences =
            PlaybackPreferenceStore.Preferences.empty();
    private TrackOption pendingTrackSelection;
    private boolean pendingSubtitleOff;
    private static final int TRACK_SECTION_AUDIO = 1;
    private static final int TRACK_SECTION_SUBTITLES = 2;

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
    private final Runnable freshStreamTimeout = new Runnable() {
        @Override public void run() {
            if (!freshStreamRequested) return;
            freshStreamRequested = false;
            recoveryToken = null;
            showStreamError(getString(R.string.player_reconnect_failed));
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
        preferenceScopeJson = getIntent().getStringExtra(EXTRA_PREFERENCE_SCOPE);
        cloudPlaybackPreferencesJson = getIntent().getStringExtra(EXTRA_PLAYBACK_PREFERENCES);
        posterUrl = getIntent().getStringExtra(EXTRA_POSTER_URL);
        nextTitle = getIntent().getStringExtra(EXTRA_NEXT_TITLE);
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
        readTrackMetadata(getIntent().getStringExtra(EXTRA_TRACK_METADATA));
        initializePlaybackPreferences();
        registerFreshStreamReceiver();
        try {
            String vj = getIntent().getStringExtra(EXTRA_VARIANTS);
            if (vj != null && !vj.isEmpty()) {
                org.json.JSONArray arr = new org.json.JSONArray(vj);
                if (arr.length() > 1) variants = arr;
            }
        } catch (Exception ignored) { variants = null; }

        playerView = new PlayerView(this);
        playerView.setId(R.id.norva_player_view);
        // Black everywhere behind the video so letterbox/pillarbox and any
        // cutout-safe insets read as clean black bars, never the theme's grey.
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        playerView.setBackgroundColor(Color.BLACK);
        playerView.setShutterBackgroundColor(Color.BLACK);

        // Root = player + a centered error overlay, so a failed stream shows the
        // real reason on screen instead of hanging silently at 00:00.
        FrameLayout root = new FrameLayout(this);
        playerRoot = root;
        root.setId(R.id.norva_player_root);
        root.setContentDescription(getString(R.string.player_show_controls));
        root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        root.setBackgroundColor(Color.BLACK);
        root.addView(playerView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // Recoverable error panel: a headline + the diagnostic detail + Retry/Back,
        // so a failed stream is a recoverable moment instead of a silent 00:00 hang.
        errorPanel = new LinearLayout(this);
        errorPanel.setId(R.id.norva_player_error_panel);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(32), dp(32), dp(32), dp(32));
        errorPanel.setVisibility(View.GONE);

        TextView errorTitle = new TextView(this);
        errorTitle.setId(R.id.norva_player_error_title);
        if (Build.VERSION.SDK_INT >= 28) errorTitle.setAccessibilityHeading(true);
        errorTitle.setText(getString(R.string.player_error_title));
        errorTitle.setTextColor(Color.WHITE);
        errorTitle.setTextSize(20);
        errorTitle.setGravity(Gravity.CENTER);
        errorTitle.setPadding(0, 0, 0, dp(12));
        errorPanel.addView(errorTitle);

        errorView = new TextView(this);
        errorView.setId(R.id.norva_player_error_message);
        errorView.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        errorView.setTextColor(Color.parseColor("#cbd5e1"));
        errorView.setTextSize(13);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(0, 0, 0, dp(24));
        errorPanel.addView(errorView);

        Button retryBtn = new Button(this);
        retryBtn.setId(R.id.norva_player_retry_button);
        retryBtn.setText(getString(R.string.player_retry));
        retryBtn.setTextColor(Color.WHITE);
        retryBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        retryBtn.setOnClickListener(v -> retryPlayback());
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(dp(220),
                LinearLayout.LayoutParams.WRAP_CONTENT);
        retryLp.bottomMargin = dp(12);
        errorPanel.addView(retryBtn, retryLp);

        Button backBtn = new Button(this);
        backBtn.setId(R.id.norva_player_error_back_button);
        backBtn.setText(getString(R.string.player_back));
        backBtn.setTextColor(Color.WHITE);
        backBtn.setBackgroundColor(Color.parseColor("#272d3a"));
        backBtn.setOnClickListener(v -> finishWithoutRecovery());
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
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l = 0, t = 0, r = 0, b = 0;
            if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                DisplayCutout dc = insets.getDisplayCutout();
                l = dc.getSafeInsetLeft();
                t = dc.getSafeInsetTop();
                r = dc.getSafeInsetRight();
                b = dc.getSafeInsetBottom();
            }
            // Reserve the navigation/gesture area even while immersive mode has
            // hidden it. Android reveals that bar transiently over the app; without
            // this stable inset, the seek bar and trailing controls become
            // untappable on gesture and classic three-button devices.
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets nav = insets.getInsetsIgnoringVisibility(
                        WindowInsets.Type.navigationBars());
                android.graphics.Insets gestures = insets.getInsets(
                        WindowInsets.Type.mandatorySystemGestures());
                l = Math.max(l, Math.max(nav.left, gestures.left));
                t = Math.max(t, Math.max(nav.top, gestures.top));
                r = Math.max(r, Math.max(nav.right, gestures.right));
                b = Math.max(b, Math.max(nav.bottom, gestures.bottom));
            } else if (Build.VERSION.SDK_INT >= 23) {
                l = Math.max(l, insets.getStableInsetLeft());
                t = Math.max(t, insets.getStableInsetTop());
                r = Math.max(r, insets.getStableInsetRight());
                b = Math.max(b, insets.getStableInsetBottom());
            }
            safeInsetLeft = l;
            safeInsetTop = t;
            safeInsetRight = r;
            safeInsetBottom = b;
            applyPlayerSafeInsets();
            return insets;
        });
        root.requestApplyInsets();
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
        // Media3's settings popup would expose a second audio selector. Keep a
        // single Norva-owned entry point; playback speed is surfaced in that
        // same panel instead of a competing gear menu.
        View media3Settings = playerView.findViewById(androidx.media3.ui.R.id.exo_settings);
        if (media3Settings != null) media3Settings.setVisibility(View.GONE);
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
        // Audio and subtitles now share one explicit Norva panel. Hiding the
        // separate stock CC button avoids two competing subtitle entry points;
        // the stock settings gear remains available for playback speed.
        playerView.setShowSubtitleButton(false);
        installGestureOverlay();
        installTopBar(root);
        installCompactBottomControls();
        // Chromecast: the receiver fetches the provider URL itself from the same
        // home network. Local (encrypted) downloads can't be cast.
        if (!isLocal) installCastSupport(root);
        installVariantControl(root);
        // The P1 resolver applies account/profile/version preferences after
        // actual TrackGroups arrive. The old per-title subtitle value is
        // migrated into that scoped store once.

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
                // Viewer-facing copy stays concise and actionable. Detailed
                // diagnostics remain available to support in Logcat.
                android.util.Log.w("NorvaPlayer", diagnose(error), error);
                showStreamError(friendlyPlaybackError(error));
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
                if (!trackPreferencesApplied) {
                    trackPreferencesApplied = true;
                    if (applyResolvedTrackPreferences(tracks)) {
                        refreshTrackControl(tracks);
                        return;
                    }
                }
                confirmPendingTrackSelection(tracks);
                refreshTrackControl(tracks);
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

    // ==================== Scoped playback preferences ====================

    private void initializePlaybackPreferences() {
        final android.content.SharedPreferences local =
                getSharedPreferences("norva_playback_preferences", MODE_PRIVATE);
        preferenceStore = new PlaybackPreferenceStore(new PlaybackPreferenceStore.Backend() {
            @Override public String get(String key) { return local.getString(key, null); }
            @Override public void put(String key, String value) {
                local.edit().putString(key, value).apply();
            }
            @Override public void remove(String key) { local.edit().remove(key).apply(); }
            @Override public boolean contains(String key) { return local.contains(key); }
        });

        org.json.JSONObject rawScope = null;
        try {
            if (preferenceScopeJson != null && !preferenceScopeJson.isEmpty()) {
                rawScope = new org.json.JSONObject(preferenceScopeJson);
            }
        } catch (Exception ignored) { rawScope = null; }
        String accountId = rawScope == null ? "" : rawScope.optString("accountId", "");
        String profileId = rawScope == null ? "" : rawScope.optString("profileId", "");
        if (!accountId.isEmpty() && profileId.isEmpty()) profileId = "account-default";
        preferenceScope = PlaybackPreferenceStore.Scope.builder()
                .accountId(accountId)
                .profileId(profileId)
                .sourceId(sourceId)
                .versionKey(rawScope == null ? itemId : rawScope.optString("versionKey", itemId))
                .itemType(itemType)
                .itemId(itemId)
                .seriesId(rawScope == null ? "" : rawScope.optString("seriesId", ""))
                .build();

        PlaybackPreferenceStore.Preferences cloudDefaults =
                parsePlaybackPreferences(cloudPlaybackPreferencesJson);
        String legacyKey = PlaybackPreferenceStore.legacySubtitleKey(itemType, itemId);
        if (legacyKey != null) {
            android.content.SharedPreferences legacy =
                    getSharedPreferences(SUB_PREFS, MODE_PRIVATE);
            String legacyValue = legacy.getString(legacyKey, null);
            if (preferenceStore.migrateLegacySubtitle(preferenceScope, legacyValue)) {
                legacy.edit().remove(legacyKey).apply();
            }
        }
        resolvedTrackPreferences = preferenceStore.resolve(preferenceScope, cloudDefaults);
        currentTrackPreferencesJson = preferencesToJson(resolvedTrackPreferences);
    }

    private static PlaybackPreferenceStore.Preferences parsePlaybackPreferences(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return PlaybackPreferenceStore.Preferences.empty();
        }
        try {
            org.json.JSONObject object = new org.json.JSONObject(raw);
            return new PlaybackPreferenceStore.Preferences(
                    parseTrackPreference(object.optJSONObject("audio")),
                    parseTrackPreference(object.optJSONObject("subtitle")));
        } catch (Exception ignored) {
            return PlaybackPreferenceStore.Preferences.empty();
        }
    }

    private static TrackSelectionResolver.Preference parseTrackPreference(
            org.json.JSONObject raw) {
        if (raw == null) return null;
        String source = raw.optString("source", "");
        String mode = raw.optString("mode", "");
        if (raw.optBoolean("disabled", false)
                || "off".equalsIgnoreCase(source)
                || "off".equalsIgnoreCase(mode)) {
            return TrackSelectionResolver.Preference.off();
        }
        String stableId = firstNonEmpty(
                raw.optString("stableId", ""),
                raw.optString("stable_id", ""));
        if (stableId == null) {
            int streamIndex = raw.has("streamIndex")
                    ? raw.optInt("streamIndex", -1)
                    : raw.optInt("stream_index", -1);
            if (streamIndex >= 0) stableId = "stream:" + streamIndex;
        }
        String language = firstNonEmpty(
                raw.optString("language", ""),
                raw.optString("lang", ""));
        TrackSelectionResolver.Role role =
                TrackSelectionResolver.Role.from(raw.optString("role", ""));
        if ((stableId == null || stableId.isEmpty())
                && (language == null || language.isEmpty())
                && role == TrackSelectionResolver.Role.UNKNOWN) {
            return null;
        }
        return TrackSelectionResolver.Preference.selected(stableId, language, role);
    }

    private static List<TrackSelectionResolver.Track> resolverTracks(
            List<TrackOption> options) {
        List<TrackSelectionResolver.Track> result = new ArrayList<>();
        for (int i = 0; i < options.size(); i++) {
            TrackOption option = options.get(i);
            result.add(new TrackSelectionResolver.Track(
                    i,
                    option.stableId,
                    option.language,
                    option.role,
                    option.supported,
                    option.selected,
                    option.defaultTrack));
        }
        return result;
    }

    private boolean applyResolvedTrackPreferences(Tracks tracks) {
        if (player == null || tracks == null || resolvedTrackPreferences == null) return false;
        androidx.media3.common.TrackSelectionParameters.Builder builder =
                player.getTrackSelectionParameters().buildUpon();
        boolean changed = false;

        TrackSelectionResolver.Preference audioPreference =
                resolvedTrackPreferences.getAudio();
        if (audioPreference != null && !audioPreference.isDisabled()) {
            List<TrackOption> audio = collectTrackOptions(tracks, C.TRACK_TYPE_AUDIO);
            TrackSelectionResolver.Resolution resolution =
                    TrackSelectionResolver.resolve(audioPreference, resolverTracks(audio));
            if (resolution.hasTrack()) {
                TrackOption option = audio.get(resolution.getTrackIndex());
                builder.setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
                        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                        .setOverrideForType(new TrackSelectionOverride(
                                option.group, option.trackIndex));
                changed = !option.selected;
            }
        }

        TrackSelectionResolver.Preference subtitlePreference =
                resolvedTrackPreferences.getSubtitle();
        if (subtitlePreference != null) {
            List<TrackOption> subtitles = collectTrackOptions(tracks, C.TRACK_TYPE_TEXT);
            if (subtitlePreference.isDisabled()) {
                builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
                changed = changed || hasSelectedTrack(subtitles);
            } else {
                TrackSelectionResolver.Resolution resolution =
                        TrackSelectionResolver.resolve(
                                subtitlePreference, resolverTracks(subtitles));
                if (resolution.hasTrack()) {
                    TrackOption option = subtitles.get(resolution.getTrackIndex());
                    builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                            .setOverrideForType(new TrackSelectionOverride(
                                    option.group, option.trackIndex));
                    changed = changed || !option.selected;
                }
            }
        }
        if (changed) player.setTrackSelectionParameters(builder.build());
        return changed;
    }

    private void confirmPendingTrackSelection(Tracks tracks) {
        if (pendingSubtitleOff) {
            List<TrackOption> subtitles = collectTrackOptions(tracks, C.TRACK_TYPE_TEXT);
            if (!hasSelectedTrack(subtitles)) {
                saveTrackPreference(C.TRACK_TYPE_TEXT, TrackSelectionResolver.Preference.off());
            } else {
                Toast.makeText(this, R.string.player_track_change_failed, Toast.LENGTH_SHORT).show();
            }
            pendingSubtitleOff = false;
        }
        if (pendingTrackSelection != null) {
            TrackOption requested = pendingTrackSelection;
            List<TrackOption> current = collectTrackOptions(tracks, requested.type);
            TrackOption selected = null;
            for (TrackOption option : current) {
                if (option.selected && option.stableId.equals(requested.stableId)) {
                    selected = option;
                    break;
                }
            }
            if (selected != null) {
                saveTrackPreference(requested.type,
                        TrackSelectionResolver.Preference.selected(
                                selected.stableId, selected.language, selected.role));
            } else {
                Toast.makeText(this, R.string.player_track_change_failed, Toast.LENGTH_SHORT).show();
            }
            pendingTrackSelection = null;
        }
        captureCurrentTrackPreferences(tracks);
    }

    private void saveTrackPreference(
            int type, TrackSelectionResolver.Preference exactPreference) {
        if (preferenceStore == null || preferenceScope == null || exactPreference == null) return;
        TrackSelectionResolver.Preference portable = exactPreference.isDisabled()
                ? TrackSelectionResolver.Preference.off()
                : TrackSelectionResolver.Preference.selected(
                        "", exactPreference.getLanguage(), exactPreference.getRole());
        if (type == C.TRACK_TYPE_AUDIO) {
            preferenceStore.saveExactAudio(preferenceScope, exactPreference);
            preferenceStore.saveSeriesAudio(preferenceScope, portable);
            preferenceStore.saveProfileAudio(preferenceScope, portable);
            resolvedTrackPreferences = resolvedTrackPreferences.withAudio(exactPreference);
        } else if (type == C.TRACK_TYPE_TEXT) {
            preferenceStore.saveExactSubtitle(preferenceScope, exactPreference);
            preferenceStore.saveSeriesSubtitle(preferenceScope, portable);
            preferenceStore.saveProfileSubtitle(preferenceScope, portable);
            resolvedTrackPreferences = resolvedTrackPreferences.withSubtitle(exactPreference);
        }
        currentTrackPreferencesJson = preferencesToJson(resolvedTrackPreferences);
    }

    private void captureCurrentTrackPreferences(Tracks tracks) {
        if (tracks == null) return;
        TrackSelectionResolver.Preference audio = null;
        for (TrackOption option : collectTrackOptions(tracks, C.TRACK_TYPE_AUDIO)) {
            if (option.selected) {
                audio = TrackSelectionResolver.Preference.selected(
                        option.stableId, option.language, option.role);
                break;
            }
        }
        TrackSelectionResolver.Preference subtitle = null;
        List<TrackOption> subtitles = collectTrackOptions(tracks, C.TRACK_TYPE_TEXT);
        for (TrackOption option : subtitles) {
            if (option.selected) {
                subtitle = TrackSelectionResolver.Preference.selected(
                        option.stableId, option.language, option.role);
                break;
            }
        }
        if (subtitle == null && !subtitles.isEmpty()) {
            subtitle = TrackSelectionResolver.Preference.off();
        }
        currentTrackPreferencesJson = preferencesToJson(
                new PlaybackPreferenceStore.Preferences(audio, subtitle));
    }

    private static String preferencesToJson(PlaybackPreferenceStore.Preferences preferences) {
        if (preferences == null || preferences.isEmpty()) return null;
        try {
            org.json.JSONObject root = new org.json.JSONObject();
            org.json.JSONObject audio = preferenceToJson(preferences.getAudio());
            org.json.JSONObject subtitle = preferenceToJson(preferences.getSubtitle());
            if (audio != null) root.put("audio", audio);
            if (subtitle != null) root.put("subtitle", subtitle);
            return root.length() == 0 ? null : root.toString();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static org.json.JSONObject preferenceToJson(
            TrackSelectionResolver.Preference preference) throws org.json.JSONException {
        if (preference == null) return null;
        org.json.JSONObject value = new org.json.JSONObject();
        if (preference.isDisabled()) {
            value.put("disabled", true);
            value.put("source", "off");
            value.put("mode", "off");
            return value;
        }
        if (!preference.getStableId().isEmpty()) {
            value.put("stableId", preference.getStableId());
        }
        if (!preference.getLanguage().isEmpty()) {
            value.put("language", preference.getLanguage());
        }
        if (preference.getRole() != TrackSelectionResolver.Role.UNKNOWN) {
            value.put("role", preference.getRole().name().toLowerCase(Locale.ROOT));
        }
        return value.length() == 0 ? null : value;
    }

    // ==================== Unified audio & subtitles ====================

    /**
     * Accept only exact-file metadata that the web layer has already reduced to
     * track-scoped evidence. Title/group aggregates are intentionally ignored:
     * they could label one provider file with a sibling version's language.
     */
    private void readTrackMetadata(String json) {
        verifiedAudioTracks = null;
        exactSubtitleTracks = null;
        hasBurnedSubtitle = false;
        burnedSubtitleLanguage = null;
        if (json == null || json.isEmpty()) return;
        try {
            org.json.JSONObject metadata = new org.json.JSONObject(json);
            String status = metadata.optString("audioValidationStatus", "").toLowerCase(Locale.ROOT);
            if ("file".equals(metadata.optString("audioTracksScope", ""))
                    && isAcceptedAudioEvidence(status)) {
                org.json.JSONArray tracks = metadata.optJSONArray("audioTracks");
                if (tracks != null) verifiedAudioTracks = tracks;
            }
            if ("file".equals(metadata.optString("subtitleTracksScope", ""))) {
                org.json.JSONArray tracks = metadata.optJSONArray("subtitleTracks");
                if (tracks != null) exactSubtitleTracks = tracks;
            }
            org.json.JSONObject burned = metadata.optJSONObject("burnedSubtitle");
            if (burned != null) {
                hasBurnedSubtitle = true;
                burnedSubtitleLanguage = safeLanguageName(burned.optString("lang", ""));
            }
        } catch (Exception ignored) {
            // Bad optional metadata must never delay or prevent playback.
        }
    }

    private static boolean isAcceptedAudioEvidence(String status) {
        return "verified".equals(status)
                || "verified_union".equals(status)
                || "probed".equals(status)
                || "probed_union".equals(status);
    }

    private static final class TrackMeta {
        int streamIndex = -1;
        String stableId;
        String language;
        String codec;
        int channels = -1;
        boolean forced;
        boolean sdh;
        boolean defaultTrack;
        TrackSelectionResolver.Role role = TrackSelectionResolver.Role.UNKNOWN;
    }

    private static final class TrackOption {
        final int type;
        final TrackGroup group;
        final int trackIndex;
        final String label;
        final String stableId;
        final String language;
        final TrackSelectionResolver.Role role;
        final boolean selected;
        final boolean supported;
        final boolean defaultTrack;

        TrackOption(int type, TrackGroup group, int trackIndex, String label,
                    String stableId, String language, TrackSelectionResolver.Role role,
                    boolean selected, boolean supported, boolean defaultTrack) {
            this.type = type;
            this.group = group;
            this.trackIndex = trackIndex;
            this.label = label;
            this.stableId = stableId;
            this.language = language;
            this.role = role;
            this.selected = selected;
            this.supported = supported;
            this.defaultTrack = defaultTrack;
        }
    }

    private TrackMeta trackMetaAt(org.json.JSONArray tracks, Format format, int ordinal) {
        if (tracks == null || tracks.length() == 0) return null;
        int formatIndex = numericTrackId(format == null ? null : format.id);
        if (formatIndex >= 0) {
            for (int i = 0; i < tracks.length(); i++) {
                org.json.JSONObject candidate = tracks.optJSONObject(i);
                if (candidate != null && candidate.optInt("index", -1) == formatIndex) {
                    return parseTrackMeta(candidate);
                }
            }
        }
        // The catalogue contract is an ordered exact-file map. Some extractors
        // omit Format.id, so ordinal is the safe fallback within the same type.
        return ordinal >= 0 && ordinal < tracks.length()
                ? parseTrackMeta(tracks.optJSONObject(ordinal))
                : null;
    }

    private static TrackMeta parseTrackMeta(org.json.JSONObject raw) {
        if (raw == null) return null;
        TrackMeta meta = new TrackMeta();
        meta.streamIndex = raw.optInt("index", -1);
        meta.stableId = raw.optString("id", "");
        meta.language = firstNonEmpty(
                raw.optString("lang", ""),
                raw.optString("language", ""),
                raw.optString("iso_639_1", ""),
                raw.optString("iso639", ""),
                raw.optString("code", ""));
        meta.codec = raw.optString("codec", "");
        meta.channels = raw.optInt("channels", raw.optInt("channelCount", -1));
        meta.forced = raw.optBoolean("forced", false)
                || raw.optBoolean("isForced", false)
                || raw.optBoolean("is_forced", false);
        meta.sdh = raw.optBoolean("sdh", false)
                || raw.optBoolean("hearingImpaired", false)
                || raw.optBoolean("hearing_impaired", false);
        meta.defaultTrack = raw.optBoolean("default", false)
                || raw.optBoolean("isDefault", false)
                || raw.optBoolean("is_default", false);
        meta.role = TrackSelectionResolver.Role.from(raw.optString("role", ""));
        if (meta.forced) meta.role = TrackSelectionResolver.Role.FORCED;
        if (meta.sdh) meta.role = TrackSelectionResolver.Role.SDH;
        return meta;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return null;
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return null;
    }

    private static int numericTrackId(String id) {
        if (id == null || id.isEmpty()) return -1;
        try {
            if (id.matches("\\d+")) return Integer.parseInt(id);
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("(\\d+)$").matcher(id);
            return matcher.find() ? Integer.parseInt(matcher.group(1)) : -1;
        } catch (Exception ignored) {
            return -1;
        }
    }

    /**
     * Turn only real ISO language codes into a display claim. Provider labels
     * and generic extractor names are never accepted as languages.
     */
    private static String safeLanguageName(String raw) {
        if (raw == null) return null;
        String code = raw.trim().toLowerCase(Locale.ROOT).replace('_', '-');
        int dash = code.indexOf('-');
        if (dash > 0) code = code.substring(0, dash);
        switch (code) {
            case "fre":
            case "fra": code = "fr"; break;
            case "eng": code = "en"; break;
            case "spa": code = "es"; break;
            case "ger":
            case "deu": code = "de"; break;
            case "ita": code = "it"; break;
            case "por": code = "pt"; break;
            case "ara": code = "ar"; break;
            case "rus": code = "ru"; break;
            case "tur": code = "tr"; break;
            case "hin": code = "hi"; break;
            case "dut":
            case "nld": code = "nl"; break;
            case "gre":
            case "ell": code = "el"; break;
            case "chi":
            case "zho": code = "zh"; break;
            case "jpn": code = "ja"; break;
            case "kor": code = "ko"; break;
            case "pol": code = "pl"; break;
            case "rum":
            case "ron": code = "ro"; break;
            case "swe": code = "sv"; break;
            case "nor": code = "no"; break;
            case "dan": code = "da"; break;
            case "fin": code = "fi"; break;
            case "heb": code = "he"; break;
            case "per":
            case "fas": code = "fa"; break;
            case "ukr": code = "uk"; break;
            default: break;
        }
        if (!code.matches("[a-z]{2,3}")
                || "und".equals(code) || "unk".equals(code)
                || "mul".equals(code) || "mis".equals(code)) return null;
        try {
            Locale language = new Locale(code);
            String display = language.getDisplayLanguage(Locale.getDefault());
            if (display == null || display.trim().isEmpty() || display.equalsIgnoreCase(code)) return null;
            return display.substring(0, 1).toUpperCase(Locale.getDefault()) + display.substring(1);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String safeCodec(String raw) {
        if (raw == null) return null;
        String codec = raw.trim().toUpperCase(Locale.ROOT);
        if (codec.startsWith("AUDIO/")) codec = codec.substring(6);
        if (codec.isEmpty() || codec.length() > 16 || !codec.matches("[A-Z0-9._+-]+")) return null;
        if ("EAC3".equals(codec)) return "E-AC-3";
        if ("AC3".equals(codec)) return "AC-3";
        return codec;
    }

    private String safeTrackLabel(int type, Format format, TrackMeta metadata, int position) {
        String language = metadata == null ? null : safeLanguageName(metadata.language);
        // Subtitle tags are track-scoped even when no catalogue row exists.
        // Audio deliberately remains fail-closed unless exact-file evidence was
        // transported, because incorrect provider audio tags caused this issue.
        if (language == null && type == C.TRACK_TYPE_TEXT && format != null) {
            language = safeLanguageName(format.language);
        }
        String label = language;
        if (label == null) {
            label = getString(type == C.TRACK_TYPE_AUDIO
                    ? R.string.player_audio_unknown
                    : R.string.player_subtitle_unknown, position);
        }

        List<String> details = new ArrayList<>();
        String codec = safeCodec(metadata != null && metadata.codec != null
                ? metadata.codec
                : (format == null ? null : format.sampleMimeType));
        if (codec != null) details.add(codec);
        int channels = metadata != null && metadata.channels > 0
                ? metadata.channels
                : (format == null ? -1 : format.channelCount);
        if (type == C.TRACK_TYPE_AUDIO && channels > 0) {
            if (channels == 1) details.add(getString(R.string.player_audio_mono));
            else if (channels == 2) details.add(getString(R.string.player_audio_stereo));
            else if (channels == 6) details.add("5.1");
            else if (channels == 8) details.add("7.1");
        }
        if (type == C.TRACK_TYPE_TEXT && metadata != null) {
            if (metadata.forced) details.add(getString(R.string.player_subtitle_forced));
            if (metadata.sdh) details.add("SDH");
        }
        return details.isEmpty() ? label : label + " · " + android.text.TextUtils.join(" · ", details);
    }

    private List<TrackOption> collectTrackOptions(Tracks tracks, int type) {
        List<TrackOption> result = new ArrayList<>();
        if (tracks == null) return result;
        int ordinal = 0;
        org.json.JSONArray metadata = type == C.TRACK_TYPE_AUDIO
                ? verifiedAudioTracks : exactSubtitleTracks;
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != type) continue;
            for (int i = 0; i < group.length; i++) {
                Format format = group.getTrackFormat(i);
                TrackMeta exact = trackMetaAt(metadata, format, ordinal);
                TrackSelectionResolver.Role role = trackRole(type, format, exact);
                String language = exact == null ? null : exact.language;
                if ((language == null || language.isEmpty()) && type == C.TRACK_TYPE_TEXT) {
                    language = format.language;
                }
                String stableId = exact != null && exact.stableId != null
                        && !exact.stableId.trim().isEmpty()
                        ? exact.stableId
                        : (exact != null && exact.streamIndex >= 0
                            ? "stream:" + exact.streamIndex
                            : (format.id != null && !format.id.trim().isEmpty()
                                ? format.id
                                : TrackSelectionResolver.fallbackStableId(
                                    type == C.TRACK_TYPE_AUDIO ? "audio" : "subtitle",
                                    language,
                                    role,
                                    exact != null ? exact.codec : format.sampleMimeType,
                                    exact != null && exact.channels > 0
                                            ? exact.channels : format.channelCount)));
                boolean defaultTrack = exact != null && exact.defaultTrack
                        || (format.selectionFlags & C.SELECTION_FLAG_DEFAULT) != 0;
                result.add(new TrackOption(
                        type,
                        group.getMediaTrackGroup(),
                        i,
                        safeTrackLabel(type, format, exact, ordinal + 1),
                        stableId,
                        language,
                        role,
                        group.isTrackSelected(i),
                        group.isTrackSupported(i),
                        defaultTrack));
                ordinal++;
            }
        }
        return result;
    }

    private static TrackSelectionResolver.Role trackRole(
            int type, Format format, TrackMeta exact) {
        if (exact != null && exact.role != TrackSelectionResolver.Role.UNKNOWN) {
            return exact.role;
        }
        if (format == null) return type == C.TRACK_TYPE_TEXT
                ? TrackSelectionResolver.Role.FULL
                : TrackSelectionResolver.Role.MAIN;
        if ((format.selectionFlags & C.SELECTION_FLAG_FORCED) != 0) {
            return TrackSelectionResolver.Role.FORCED;
        }
        if ((format.roleFlags & C.ROLE_FLAG_DESCRIBES_VIDEO) != 0) {
            return TrackSelectionResolver.Role.AUDIO_DESCRIPTION;
        }
        if ((format.roleFlags & C.ROLE_FLAG_COMMENTARY) != 0) {
            return TrackSelectionResolver.Role.COMMENTARY;
        }
        if ((format.roleFlags & C.ROLE_FLAG_DUB) != 0) {
            return TrackSelectionResolver.Role.DUB;
        }
        if ((format.roleFlags & (C.ROLE_FLAG_TRANSCRIBES_DIALOG
                | C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND)) != 0) {
            return TrackSelectionResolver.Role.SDH;
        }
        return type == C.TRACK_TYPE_TEXT
                ? TrackSelectionResolver.Role.FULL
                : TrackSelectionResolver.Role.MAIN;
    }

    private android.widget.ImageButton compactIconButton(
            int id, int drawable, int description, View.OnClickListener listener) {
        android.widget.ImageButton button = new android.widget.ImageButton(this);
        button.setId(id);
        button.setImageResource(drawable);
        button.setColorFilter(Color.WHITE);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setPadding(dp(9), dp(9), dp(9), dp(9));
        button.setMinimumWidth(dp(48));
        button.setMinimumHeight(dp(48));
        button.setContentDescription(getString(description));
        button.setOnClickListener(listener);
        if (Build.VERSION.SDK_INT >= 26) button.setTooltipText(getString(description));
        return button;
    }

    /**
     * Keep every secondary playback action in Media3's own bottom action row.
     * This preserves the progress-bar geometry and keeps the title/back overlay
     * clear of the lock control on small landscape phones.
     */
    private void installCompactBottomControls() {
        LinearLayout media3Actions =
                playerView.findViewById(androidx.media3.ui.R.id.exo_basic_controls);
        if (media3Actions == null) return;
        LinearLayout media3Overflow =
                playerView.findViewById(androidx.media3.ui.R.id.exo_extra_controls);

        audioButton = compactIconButton(
                R.id.norva_player_audio_button,
                androidx.media3.ui.R.drawable.exo_ic_audiotrack,
                R.string.player_audio_button,
                v -> openTrackSection(TRACK_SECTION_AUDIO));
        audioButton.setVisibility(View.GONE);

        subtitleButton = compactIconButton(
                R.id.norva_player_subtitle_button,
                androidx.media3.ui.R.drawable.exo_ic_subtitle_off,
                R.string.player_subtitles_button,
                v -> openTrackSection(TRACK_SECTION_SUBTITLES));
        subtitleButton.setVisibility(View.GONE);

        brightnessButton = compactIconButton(
                R.id.norva_player_brightness_button,
                android.R.drawable.ic_menu_day,
                R.string.player_brightness,
                v -> showBrightnessDialog());

        resizeButton = compactIconButton(
                R.id.norva_player_resize_button,
                android.R.drawable.ic_menu_crop,
                R.string.player_resize,
                v -> toggleResizeMode());

        lockBtn = compactIconButton(
                R.id.norva_player_lock_button,
                android.R.drawable.ic_lock_lock,
                R.string.player_lock,
                v -> setControlsLocked(true));

        View settings = playerView.findViewById(androidx.media3.ui.R.id.exo_settings);
        int insertAt = settings == null ? media3Actions.getChildCount()
                : Math.max(0, media3Actions.indexOfChild(settings));
        LinearLayout.LayoutParams actionLp = new LinearLayout.LayoutParams(dp(48), dp(48));
        // Add primary actions as direct Media3 children so its layout manager can
        // move them into the stock overflow instead of treating five icons as one
        // indivisible block.
        media3Actions.addView(audioButton, insertAt++, new LinearLayout.LayoutParams(actionLp));
        media3Actions.addView(subtitleButton, insertAt++, new LinearLayout.LayoutParams(actionLp));
        media3Actions.addView(lockBtn, insertAt, new LinearLayout.LayoutParams(actionLp));

        // Brightness and resize duplicate gestures, so they live in the secondary
        // Media3 tray. They remain explicit and accessible without competing with
        // elapsed/duration, audio, CC or Lock.
        if (media3Overflow != null) {
            // Media3 requires exo_overflow_hide to remain the final child. Its
            // layout manager temporarily moves every preceding extra into the
            // primary row, then overflows only what does not fit.
            View overflowHide =
                    playerView.findViewById(androidx.media3.ui.R.id.exo_overflow_hide);
            int extraInsertAt = overflowHide == null
                    ? media3Overflow.getChildCount()
                    : Math.max(0, media3Overflow.indexOfChild(overflowHide));
            media3Overflow.addView(brightnessButton, extraInsertAt++,
                    new LinearLayout.LayoutParams(dp(48), dp(48)));
            media3Overflow.addView(resizeButton, extraInsertAt,
                    new LinearLayout.LayoutParams(dp(48), dp(48)));
        }
    }

    private void updateCompactControlVisibility(boolean controllerVisible) {
        boolean visible = controllerVisible && !controlsLocked;
        int availableWidthDp = getResources().getConfiguration().screenWidthDp;
        if (audioButton != null) {
            audioButton.setVisibility(visible && hasAudioChoices ? View.VISIBLE : View.GONE);
        }
        if (subtitleButton != null) {
            subtitleButton.setVisibility(visible && hasSubtitleChoices ? View.VISIBLE : View.GONE);
        }
        // Audio, captions and Lock are the primary actions. On a compact or
        // multi-window player, brightness remains available through the vertical
        // gesture and resize through pinch, so those duplicate icons yield first
        // instead of squeezing the duration or Android navigation affordance.
        if (brightnessButton != null) {
            brightnessButton.setVisibility(
                    visible && availableWidthDp >= 480 ? View.VISIBLE : View.GONE);
        }
        if (resizeButton != null) {
            resizeButton.setVisibility(
                    visible && availableWidthDp >= 480 ? View.VISIBLE : View.GONE);
        }
        if (lockBtn != null) {
            lockBtn.setVisibility(visible ? View.VISIBLE : View.GONE);
        }
    }

    private void toggleResizeMode() {
        if (playerView == null) return;
        int next = playerView.getResizeMode() == AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                : AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
        playerView.setResizeMode(next);
        String label = getString(next == AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                ? R.string.player_resize_zoom
                : R.string.player_resize_fit);
        if (resizeButton != null) {
            resizeButton.setContentDescription(
                    getString(R.string.player_resize_selected_description, label));
        }
        showSeekFeedback(getString(R.string.player_resize_feedback, label));
        NativePlayerUiTelemetry.log(this, "player_gesture", "tap", "resize",
                next == AspectRatioFrameLayout.RESIZE_MODE_ZOOM ? "zoom" : "fit");
    }

    private float currentBrightness() {
        float value = getWindow().getAttributes().screenBrightness;
        if (value >= 0f) return Math.max(0.02f, Math.min(1f, value));
        try {
            return Math.max(0.02f, Math.min(1f,
                    android.provider.Settings.System.getInt(
                            getContentResolver(),
                            android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f));
        } catch (Exception ignored) {
            return 0.5f;
        }
    }

    private void setWindowBrightness(float value) {
        float bounded = Math.max(0.02f, Math.min(1f, value));
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = bounded;
        getWindow().setAttributes(lp);
        showSeekFeedback(getString(R.string.player_brightness_value,
                Math.round(bounded * 100)));
    }

    private void showBrightnessDialog() {
        final SeekBar bar = new SeekBar(this);
        bar.setMax(100);
        bar.setProgress(Math.round(currentBrightness() * 100));
        bar.setPadding(dp(24), dp(12), dp(24), dp(4));
        bar.setContentDescription(getString(R.string.player_brightness));
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser) setWindowBrightness(Math.max(2, progress) / 100f);
            }
            @Override public void onStartTrackingTouch(SeekBar seekBar) { }
            @Override public void onStopTrackingTouch(SeekBar seekBar) {
                NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                        "slider", "brightness", String.valueOf(seekBar.getProgress()));
            }
        });
        new android.app.AlertDialog.Builder(this, android.app.AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle(R.string.player_brightness)
                .setView(bar)
                .setNegativeButton(R.string.player_tracks_close, null)
                .show();
    }

    private void refreshTrackControl(Tracks tracks) {
        if (audioButton == null || subtitleButton == null) return;
        List<TrackOption> audio = collectTrackOptions(tracks, C.TRACK_TYPE_AUDIO);
        List<TrackOption> subtitles = collectTrackOptions(tracks, C.TRACK_TYPE_TEXT);
        hasAudioChoices = !audio.isEmpty();
        hasSubtitleChoices = !subtitles.isEmpty() || hasBurnedSubtitle;
        selectedAudioLabel = selectedLabel(audio, getString(R.string.player_audio_unavailable));
        String burnedLabel = burnedSubtitleLabel();
        selectedSubtitleLabel = hasBurnedSubtitle
                ? burnedLabel
                : selectedLabel(subtitles, getString(R.string.player_subtitles_off));
        audioButton.setContentDescription(getString(
                R.string.player_audio_selected_description, selectedAudioLabel));
        subtitleButton.setContentDescription(getString(
                R.string.player_subtitles_selected_description, selectedSubtitleLabel));
        subtitleButton.setImageResource(
                hasBurnedSubtitle || hasSelectedTrack(subtitles)
                        ? androidx.media3.ui.R.drawable.exo_ic_subtitle_on
                        : androidx.media3.ui.R.drawable.exo_ic_subtitle_off);
        updateTrackButtonVisibility(playerView != null && playerView.isControllerFullyVisible());
    }

    private static String selectedLabel(List<TrackOption> options, String fallback) {
        for (TrackOption option : options) {
            if (option.selected) return option.label;
        }
        return fallback;
    }

    private void updateTrackButtonVisibility(boolean controllerVisible) {
        updateCompactControlVisibility(controllerVisible);
    }

    private void openTrackSection(int section) {
        NativePlayerUiTelemetry.log(this, "player_tracks_open", "open",
                section == TRACK_SECTION_AUDIO ? "audio" : "subtitle",
                hasBurnedSubtitle ? "burned_subtitles" : "available");
        showTrackDialog(section);
    }

    private TextView sectionTitle(String text) {
        TextView title = new TextView(this);
        title.setText(text);
        title.setTextColor(Color.WHITE);
        title.setTextSize(17);
        title.setPadding(0, dp(14), 0, dp(6));
        if (Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        return title;
    }

    private TextView emptyTrackMessage(String text) {
        TextView message = new TextView(this);
        message.setText(text);
        message.setTextColor(Color.parseColor("#94A3B8"));
        message.setTextSize(14);
        message.setPadding(dp(8), dp(8), dp(8), dp(12));
        return message;
    }

    private RadioButton trackRadio(String text, boolean checked, boolean enabled) {
        RadioButton radio = new RadioButton(this);
        radio.setText(text);
        radio.setTextColor(enabled ? Color.WHITE : Color.parseColor("#64748B"));
        radio.setTextSize(15);
        radio.setChecked(checked);
        radio.setEnabled(enabled);
        radio.setMinHeight(dp(48));
        radio.setPadding(dp(4), 0, dp(4), 0);
        return radio;
    }

    private void showTrackDialog(int initialSection) {
        if (player == null) return;
        final List<TrackOption> audio = collectTrackOptions(
                player.getCurrentTracks(), C.TRACK_TYPE_AUDIO);
        final List<TrackOption> subtitles = collectTrackOptions(
                player.getCurrentTracks(), C.TRACK_TYPE_TEXT);
        if (audio.isEmpty() && subtitles.isEmpty() && !hasBurnedSubtitle) {
            Toast.makeText(this, R.string.player_tracks_unavailable, Toast.LENGTH_SHORT).show();
            return;
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setId(R.id.norva_player_track_dialog);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(4), dp(20), dp(16));
        scroll.addView(content, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));

        TextView audioTitle = sectionTitle(getString(R.string.player_audio_section));
        audioTitle.setId(R.id.norva_player_audio_section);
        content.addView(audioTitle);
        final List<RadioButton> audioRows = new ArrayList<>();
        if (audio.isEmpty()) {
            content.addView(emptyTrackMessage(getString(R.string.player_audio_unavailable)));
        } else {
            for (int i = 0; i < audio.size(); i++) {
                final int picked = i;
                TrackOption option = audio.get(i);
                RadioButton row = trackRadio(option.label, option.selected, option.supported);
                audioRows.add(row);
                row.setOnClickListener(v -> {
                    if (selectTrack(audio.get(picked))) {
                        NativePlayerUiTelemetry.log(this, "player_track_select",
                                "select", "audio", audio.get(picked).language);
                        for (int j = 0; j < audioRows.size(); j++) {
                            audioRows.get(j).setChecked(j == picked);
                        }
                    } else {
                        NativePlayerUiTelemetry.log(this, "player_track_select_fail",
                                "select", "audio", "failed");
                        row.setChecked(option.selected);
                    }
                });
                content.addView(row);
            }
        }

        TextView subtitleTitle = sectionTitle(getString(R.string.player_subtitle_section));
        subtitleTitle.setId(R.id.norva_player_subtitle_section);
        content.addView(subtitleTitle);
        final List<RadioButton> subtitleRows = new ArrayList<>();
        boolean subtitleSelected = false;
        for (TrackOption option : subtitles) subtitleSelected |= option.selected;
        if (hasBurnedSubtitle) {
            RadioButton burned = trackRadio(burnedSubtitleLabel(), true, false);
            burned.setContentDescription(
                    burnedSubtitleLabel() + ". "
                            + getString(R.string.player_subtitles_burned_in_detail));
            content.addView(burned);
            content.addView(emptyTrackMessage(
                    getString(R.string.player_subtitles_burned_in_detail)));
        } else {
            RadioButton off = trackRadio(
                    getString(R.string.player_subtitles_off), !subtitleSelected, true);
            subtitleRows.add(off);
            off.setOnClickListener(v -> {
                if (disableSubtitles()) {
                    NativePlayerUiTelemetry.log(this, "player_track_select",
                            "off", "subtitle", "off");
                    for (RadioButton row : subtitleRows) row.setChecked(row == off);
                } else {
                    NativePlayerUiTelemetry.log(this, "player_track_select_fail",
                            "off", "subtitle", "failed");
                    off.setChecked(!hasSelectedTrack(subtitles));
                }
            });
            content.addView(off);
        }
        for (int i = 0; i < subtitles.size(); i++) {
            final int picked = i;
            TrackOption option = subtitles.get(i);
            RadioButton row = trackRadio(option.label, option.selected, option.supported);
            subtitleRows.add(row);
            row.setOnClickListener(v -> {
                if (selectTrack(subtitles.get(picked))) {
                    NativePlayerUiTelemetry.log(this, "player_track_select",
                            "select", "subtitle", subtitles.get(picked).language);
                    for (int j = 0; j < subtitleRows.size(); j++) {
                        subtitleRows.get(j).setChecked(
                                j == picked + (hasBurnedSubtitle ? 0 : 1));
                    }
                } else {
                    NativePlayerUiTelemetry.log(this, "player_track_select_fail",
                            "select", "subtitle", "failed");
                    row.setChecked(option.selected);
                }
            });
            content.addView(row);
        }
        if (subtitles.isEmpty() && !hasBurnedSubtitle) {
            content.addView(emptyTrackMessage(getString(R.string.player_subtitles_unavailable)));
        }

        if (!isLiveContent()) {
            content.addView(sectionTitle(getString(R.string.player_playback_speed_section)));
            final float[] speeds = new float[] { 0.75f, 1f, 1.25f, 1.5f, 2f };
            final List<RadioButton> speedRows = new ArrayList<>();
            float currentSpeed = player.getPlaybackParameters().speed;
            for (int i = 0; i < speeds.length; i++) {
                final int picked = i;
                String label = speeds[i] == 1f
                        ? getString(R.string.player_playback_speed_normal)
                        : String.format(Locale.ROOT, "%s×", speeds[i]);
                RadioButton row = trackRadio(
                        label, Math.abs(currentSpeed - speeds[i]) < 0.01f, true);
                speedRows.add(row);
                row.setOnClickListener(v -> {
                    try {
                        player.setPlaybackSpeed(speeds[picked]);
                        NativePlayerUiTelemetry.log(this, "player_track_select",
                                "select", "speed", String.format(Locale.ROOT, "%.2f", speeds[picked]));
                        for (int j = 0; j < speedRows.size(); j++) {
                            speedRows.get(j).setChecked(j == picked);
                        }
                    } catch (Throwable ignored) {
                        NativePlayerUiTelemetry.log(this, "player_track_select_fail",
                                "select", "speed", "failed");
                        row.setChecked(false);
                        Toast.makeText(this, R.string.player_track_change_failed,
                                Toast.LENGTH_SHORT).show();
                    }
                });
                content.addView(row);
            }
        }

        if (trackDialog != null) trackDialog.dismiss();
        trackDialog = new android.app.AlertDialog.Builder(
                this, android.app.AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle(R.string.player_tracks_title)
                .setView(scroll)
                .setNegativeButton(R.string.player_tracks_close, null)
                .create();
        trackDialog.setOnDismissListener(d -> trackDialog = null);
        trackDialog.show();
        TextView focusSection = initialSection == TRACK_SECTION_SUBTITLES
                ? subtitleTitle : audioTitle;
        focusSection.setFocusable(true);
        focusSection.requestFocus();
        scroll.post(() -> scroll.smoothScrollTo(0, Math.max(0, focusSection.getTop())));
    }

    private String burnedSubtitleLabel() {
        return burnedSubtitleLanguage == null
                ? getString(R.string.player_subtitles_burned_in_unknown)
                : getString(R.string.player_subtitles_burned_in, burnedSubtitleLanguage);
    }

    private void installTopBar(FrameLayout root) {
        topBar = new LinearLayout(this);
        topBar.setId(R.id.norva_player_top_bar);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setPadding(dp(12), dp(6), dp(12), dp(6));
        topBar.setBackgroundColor(Color.TRANSPARENT);
        topBar.setVisibility(View.GONE);

        android.widget.ImageButton back = new android.widget.ImageButton(this);
        back.setId(R.id.norva_player_back_button);
        back.setImageResource(android.R.drawable.ic_menu_revert);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setContentDescription(getString(R.string.player_back_content_description));
        back.setOnClickListener(v -> finishWithoutRecovery());
        topBar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

        TextView title = new TextView(this);
        title.setId(R.id.norva_player_title);
        title.setText(mediaTitle == null || mediaTitle.trim().isEmpty() ? "Norva" : mediaTitle);
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setShadowLayer(dp(2), 0, dp(1), Color.BLACK);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        titleLp.leftMargin = dp(8);
        topBar.addView(title, titleLp);
        root.addView(topBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));
        applyPlayerSafeInsets();
    }

    private void applyPlayerSafeInsets() {
        if (playerView != null) {
            View controller = playerView.findViewById(androidx.media3.ui.R.id.exo_controller);
            if (controller != null) {
                controller.setPadding(
                        safeInsetLeft, safeInsetTop, safeInsetRight, safeInsetBottom);
            }
        }
        if (topBar != null) {
            topBar.setPadding(
                    dp(12) + safeInsetLeft,
                    dp(6) + safeInsetTop,
                    dp(12) + safeInsetRight,
                    dp(6));
        }
        if (castBar != null) {
            castBar.setPadding(
                    dp(20) + safeInsetLeft,
                    dp(12) + safeInsetTop,
                    dp(20) + safeInsetRight,
                    dp(12));
        }
        if (errorPanel != null) {
            errorPanel.setPadding(
                    dp(32) + safeInsetLeft,
                    dp(32) + safeInsetTop,
                    dp(32) + safeInsetRight,
                    dp(32) + safeInsetBottom);
        }
    }

    private void updateTopBarVisibility(boolean controllerVisible) {
        if (topBar != null) {
            topBar.setVisibility(controllerVisible && !controlsLocked ? View.VISIBLE : View.GONE);
        }
    }

    private void registerFreshStreamReceiver() {
        freshStreamReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!ACTION_APPLY_FRESH_STREAM.equals(intent.getAction())) return;
                String token = intent.getStringExtra(EXTRA_RECOVERY_TOKEN);
                String payload = intent.getStringExtra(EXTRA_RECOVERY_PAYLOAD);
                if (!freshStreamRequested || recoveryToken == null
                        || !recoveryToken.equals(token) || payload == null) return;
                applyFreshStreamPayload(payload);
            }
        };
        ContextCompat.registerReceiver(
                this,
                freshStreamReceiver,
                new IntentFilter(ACTION_APPLY_FRESH_STREAM),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void applyFreshStreamPayload(String payloadJson) {
        try {
            org.json.JSONObject payload = new org.json.JSONObject(payloadJson);
            String nextUrl = payload.optString("url", "");
            if (nextUrl.isEmpty() || player == null) throw new IllegalArgumentException("missing url");
            String nextSource = payload.optString("sourceId", "");
            String nextItem = payload.optString("itemId", "");
            if (!String.valueOf(sourceId).equals(nextSource)
                    || !String.valueOf(itemId).equals(nextItem)) {
                throw new SecurityException("item mismatch");
            }

            errHandler.removeCallbacks(freshStreamTimeout);
            freshStreamRequested = false;
            recoveryToken = null;
            originalUrl = nextUrl;
            fallbackUrl = emptyToNull(payload.optString("fallbackUrl", ""));
            streamHost = hostOf(nextUrl);
            fallbackTried = false;
            playRetries = 0;
            trackPreferencesApplied = false;
            org.json.JSONObject metadata = payload.optJSONObject("trackMetadata");
            readTrackMetadata(metadata == null ? null : metadata.toString());
            org.json.JSONObject scope = payload.optJSONObject("preferenceScope");
            if (scope != null) preferenceScopeJson = scope.toString();
            org.json.JSONObject preferences = payload.optJSONObject("playbackPreferences");
            if (preferences != null) cloudPlaybackPreferencesJson = preferences.toString();
            long requestedPosition = Math.max(0L, payload.optLong("resumeSeconds", 0L) * 1000L);
            if (errorPanel != null) errorPanel.setVisibility(View.GONE);
            showSeekFeedback(getString(R.string.player_reconnecting));
            originalMediaItem = new MediaItem.Builder().setUri(nextUrl).build();
            player.setMediaItem(originalMediaItem, requestedPosition);
            player.prepare();
            player.setPlayWhenReady(true);
        } catch (Exception ignored) {
            freshStreamRequested = false;
            recoveryToken = null;
            errHandler.removeCallbacks(freshStreamTimeout);
            showStreamError(getString(R.string.player_reconnect_failed));
        }
    }

    private static String emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }

    private void finishWithoutRecovery() {
        freshStreamRequested = false;
        recoveryToken = null;
        errHandler.removeCallbacks(freshStreamTimeout);
        finish();
    }

    private static boolean hasSelectedTrack(List<TrackOption> options) {
        for (TrackOption option : options) if (option.selected) return true;
        return false;
    }

    /**
     * Selection is deliberately in-place. A malformed or unsupported option
     * leaves the current stream untouched and never finishes PlayerActivity.
     */
    private boolean selectTrack(TrackOption option) {
        if (player == null || option == null || !option.supported) return false;
        try {
            pendingTrackSelection = option;
            pendingSubtitleOff = false;
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(option.type, false)
                    .setOverrideForType(new TrackSelectionOverride(option.group, option.trackIndex))
                    .build());
            return true;
        } catch (Throwable ignored) {
            pendingTrackSelection = null;
            Toast.makeText(this, R.string.player_track_change_failed, Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    private boolean disableSubtitles() {
        if (player == null) return false;
        try {
            pendingTrackSelection = null;
            pendingSubtitleOff = true;
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    .build());
            return true;
        } catch (Throwable ignored) {
            pendingSubtitleOff = false;
            Toast.makeText(this, R.string.player_track_change_failed, Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    // ==================== Error display ====================

    private void showStreamError(String message) {
        if (errorView == null || errorPanel == null) return;
        errorView.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        errorPanel.bringToFront();
        errorPanel.requestFocus();
        NativePlayerUiTelemetry.log(this, "player_error_action", "show", "error", "visible");
    }

    /** A manual retry must resolve a new provider/Gateway session, not reuse a stale signed URL. */
    private void retryPlayback() {
        NativePlayerUiTelemetry.log(this, "player_error_action", "retry", "error", "manual");
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
            showStreamError(getString(R.string.player_error_network));
            return;
        }
        freshStreamRequested = true;
        freshStreamReason = reason == null ? "playback_interrupted" : reason;
        recoveryToken = UUID.randomUUID().toString();
        long position = recoverPositionMs();
        long duration = player != null && player.getDuration() > 0
                ? player.getDuration() : 0L;
        showStreamError(getString(R.string.player_reconnecting));
        // Release the active provider socket before resolving its replacement.
        // This protects one-slot IPTV accounts while the Activity stays open.
        if (player != null) player.stop();
        Intent request = new Intent(ACTION_REQUEST_FRESH_STREAM)
                .setPackage(getPackageName())
                .putExtra(EXTRA_RECOVERY_TOKEN, recoveryToken)
                .putExtra(EXTRA_SOURCE_ID, sourceId)
                .putExtra(EXTRA_ITEM_TYPE, itemType)
                .putExtra(EXTRA_ITEM_ID, itemId)
                .putExtra("positionSeconds", Math.max(0L, position / 1000L))
                .putExtra("durationSeconds", Math.max(0L, duration / 1000L))
                .putExtra("retryReason", freshStreamReason);
        sendBroadcast(request);
        errHandler.removeCallbacks(freshStreamTimeout);
        errHandler.postDelayed(freshStreamTimeout, 25_000L);
    }

    /** Reload from the gateway fallback URL after a direct-URL refusal (e.g. provider 401). */
    private void switchToFallback() {
        recoveryGeneration++;
        fallbackTried = true;
        playRetries = 0;              // one fresh in-place retry budget for the fallback URL
        trackPreferencesApplied = false;
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

    private String friendlyPlaybackError(PlaybackException error) {
        if (error == null) return getString(R.string.player_error_generic);
        int code = error.errorCode;
        if (code >= PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                && code <= PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE) {
            return getString(R.string.player_error_network);
        }
        if (code >= PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED
                && code <= PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED) {
            return getString(R.string.player_error_unsupported);
        }
        return getString(R.string.player_error_generic);
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
        seekBubble.setId(R.id.norva_player_seek_feedback);
        seekBubble.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
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
                showSeekFeedback(getString(forward
                        ? R.string.player_seek_forward_feedback
                        : R.string.player_seek_backward_feedback));
                NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                        "double_tap", "seek", forward ? "forward" : "back");
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
                    showSeekFeedback(getString(R.string.player_brightness_value,
                            Math.round(b * 100)));
                    NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                            "drag", "brightness", "adjust");
                } else if (audio != null) {
                    int max = audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC);
                    int v = Math.round(Math.max(0, Math.min(max,
                            gestureStartVolume + (totalDy / range) * max)));
                    audio.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, v, 0);
                    showSeekFeedback(getString(R.string.player_volume_value,
                            Math.round(v * 100f / max)));
                    NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                            "drag", "volume", "adjust");
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
                        if (resizeButton != null) {
                            resizeButton.setContentDescription(getString(
                                    R.string.player_resize_selected_description,
                                    getString(R.string.player_resize_zoom)));
                        }
                        showSeekFeedback(getString(R.string.player_resize_feedback,
                                getString(R.string.player_resize_zoom)));
                        NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                                "pinch", "resize", "zoom");
                    } else if (pinchAccum < 0.87f) {
                        playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
                        if (resizeButton != null) {
                            resizeButton.setContentDescription(getString(
                                    R.string.player_resize_selected_description,
                                    getString(R.string.player_resize_fit)));
                        }
                        showSeekFeedback(getString(R.string.player_resize_feedback,
                                getString(R.string.player_resize_fit)));
                        NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                                "pinch", "resize", "fit");
                    }
                }
                pinchAccum = 1f;
            }
        });

        View touchLayer = new View(this);
        touchLayer.setId(R.id.norva_player_controls);
        touchLayer.setContentDescription(getString(R.string.player_show_controls));
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

        // All visible actions, including Lock, live in Media3's bottom row.
        // Only the temporary Unlock affordance floats over the picture while
        // controls are locked.
        playerView.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) visibility -> {
            updateTrackButtonVisibility(visibility == View.VISIBLE);
            updateTopBarVisibility(visibility == View.VISIBLE);
        });

        unlockBtn = new Button(this);
        unlockBtn.setId(R.id.norva_player_unlock_button);
        unlockBtn.setText(getString(R.string.player_unlock));
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
            if (lockBtn != null) lockBtn.setVisibility(View.GONE);
            updateTrackButtonVisibility(false);
            updateTopBarVisibility(false);
            updateCompactControlVisibility(false);
            flashUnlockButton();
        } else {
            unlockBtn.removeCallbacks(hideUnlockBtn);
            unlockBtn.setVisibility(View.GONE);
            playerView.showController();
            updateTrackButtonVisibility(true);
            updateTopBarVisibility(true);
            updateCompactControlVisibility(true);
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
        if (variants == null || topBar == null) return;
        variantButton = new Button(this);
        variantButton.setId(R.id.norva_player_variant_button);
        variantButton.setText(currentVariantLabel() + "  ▾");
        variantButton.setAllCaps(false);
        variantButton.setTextColor(Color.WHITE);
        variantButton.setTextSize(13);
        variantButton.setMinHeight(dp(48));
        variantButton.setBackgroundColor(Color.parseColor("#66000000"));
        variantButton.setContentDescription(getString(R.string.player_version_change_description));
        variantButton.setOnClickListener(v -> {
            NativePlayerUiTelemetry.log(this, "player_ui_summary",
                    "open", "variant", "available");
            showVariantDialog();
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(48));
        lp.leftMargin = dp(8);
        topBar.addView(variantButton, lp);
    }

    private String currentVariantLabel() {
        if (variants == null) return getString(R.string.player_version);
        try {
            for (int i = 0; i < variants.length(); i++) {
                org.json.JSONObject v = variants.optJSONObject(i);
                if (v != null && activeStreamId != null && activeStreamId.equals(v.optString("streamId")))
                    return v.optString("label", getString(R.string.player_version));
            }
        } catch (Exception ignored) { }
        return getString(R.string.player_version);
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
                .setTitle(R.string.player_version_title)
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
        castButton.setId(R.id.norva_player_cast_button);
        castButton.setImageResource(R.drawable.ic_cast);
        castButton.setBackgroundColor(Color.parseColor("#66000000"));
        castButton.setPadding(dp(12), dp(12), dp(12), dp(12));
        castButton.setContentDescription(getString(R.string.player_cast_description));
        castButton.setVisibility(View.GONE);
        castButton.setOnClickListener(v -> {
            NativePlayerUiTelemetry.log(this, "player_ui_summary",
                    "open", "cast", "picker");
            if (castSupport != null) castSupport.showRoutePicker();
        });
        if (topBar != null) {
            LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(dp(48), dp(48));
            btnLp.leftMargin = dp(8);
            topBar.addView(castButton, btnLp);
        }

        castBar = new LinearLayout(this);
        castBar.setId(R.id.norva_player_cast_bar);
        castBar.setContentDescription(getString(R.string.player_cast_description));
        castBar.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        castBar.setOrientation(LinearLayout.HORIZONTAL);
        castBar.setGravity(Gravity.CENTER_VERTICAL);
        castBar.setBackgroundColor(Color.parseColor("#CC0A0A0F"));
        castBar.setPadding(dp(20), dp(12), dp(20), dp(12));
        castBar.setVisibility(View.GONE);

        castBarLabel = new TextView(this);
        castBarLabel.setId(R.id.norva_player_cast_label);
        castBarLabel.setTextColor(Color.WHITE);
        castBarLabel.setTextSize(15);
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        castBar.addView(castBarLabel, labelLp);

        Button pauseBtn = new Button(this);
        pauseBtn.setId(R.id.norva_player_cast_pause_button);
        pauseBtn.setContentDescription(getString(R.string.player_cast_pause_resume));
        pauseBtn.setText("⏯");
        pauseBtn.setTextColor(Color.WHITE);
        pauseBtn.setBackgroundColor(Color.parseColor("#33FFFFFF"));
        pauseBtn.setOnClickListener(v -> { if (castSupport != null) castSupport.toggleRemotePlayback(); });
        LinearLayout.LayoutParams pauseLp = new LinearLayout.LayoutParams(
                dp(56), LinearLayout.LayoutParams.WRAP_CONTENT);
        pauseLp.rightMargin = dp(10);
        castBar.addView(pauseBtn, pauseLp);

        Button stopBtn = new Button(this);
        stopBtn.setId(R.id.norva_player_cast_stop_button);
        stopBtn.setText(getString(R.string.player_cast_stop));
        stopBtn.setTextColor(Color.WHITE);
        stopBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        stopBtn.setOnClickListener(v -> { if (castSupport != null) castSupport.endSession(); });
        castBar.addView(stopBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(castBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));
        applyPlayerSafeInsets();

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
                    // Stop (not merely pause) before the receiver opens the URL:
                    // providers with one allowed socket otherwise see two active
                    // consumers during hand-off and reject the Chromecast.
                    if (player != null) {
                        player.pause();
                        player.stop();
                    }
                    castSupport.loadMedia(castUrl, mediaTitle, posterUrl, live ? 0 : pos, live);
                    if (castBarLabel != null) {
                        castBarLabel.setText(getString(
                                R.string.player_cast_connected_to, deviceName));
                    }
                    if (castBar != null) castBar.setVisibility(View.VISIBLE);
                });
            }

            @Override
            public void onCastEnded(long resumePositionMs) {
                runOnUiThread(() -> {
                    if (castBar != null) castBar.setVisibility(View.GONE);
                    if (player != null) {
                        String localUrl = fallbackTried && fallbackUrl != null
                                ? fallbackUrl : originalUrl;
                        trackPreferencesApplied = false;
                        player.setMediaItem(new MediaItem.Builder().setUri(localUrl).build(),
                                resumePositionMs > 0 && !"channel".equals(itemType)
                                        ? resumePositionMs : 0L);
                        player.prepare();
                        player.setPlayWhenReady(true);
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
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        android.view.WindowInsetsController
                                .BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
        if (playerRoot != null) playerRoot.requestApplyInsets();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyImmersive();
        if (playerRoot != null) playerRoot.requestApplyInsets();
        updateCompactControlVisibility(
                playerView != null && playerView.isControllerFullyVisible());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    public void onBackPressed() {
        if (trackDialog != null) {
            trackDialog.dismiss();
            return;
        }
        finishWithoutRecovery();
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
            if (currentTrackPreferencesJson != null
                    && !currentTrackPreferencesJson.isEmpty()) {
                if (data == null) data = new Intent();
                data.putExtra("sourceId", sourceId);
                data.putExtra("itemType", itemType);
                data.putExtra("itemId", itemId);
                data.putExtra("trackPreferences", currentTrackPreferencesJson);
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
        if (freshStreamReceiver != null) {
            try { unregisterReceiver(freshStreamReceiver); } catch (Exception ignored) { }
            freshStreamReceiver = null;
        }
        if (trackDialog != null) { trackDialog.dismiss(); trackDialog = null; }
        if (pipReceiver != null) { try { unregisterReceiver(pipReceiver); } catch (Exception ignored) { } pipReceiver = null; }
        if (castSupport != null) { castSupport.stop(); castSupport = null; }
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }
}
