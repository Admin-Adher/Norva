package tv.norva.phone;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.graphics.drawable.Icon;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
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
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.google.firebase.analytics.FirebaseAnalytics;

import tv.norva.analytics.NativeClarity;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Norva phone/tablet native player (ExoPlayer / media3).
 *
 * Plays the stream directly from the user's home network (residential IP) with
 * hardware decoders, and reports the final position back so the cloud history
 * resumes on other devices. Touch controls come from media3-ui PlayerView.
 */
@OptIn(markerClass = UnstableApi.class)
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
    public static final String EXTRA_PREVIOUS_TITLE = "previousTitle";
    public static final String EXTRA_NEXT_TITLE = "nextTitle";
    public static final String EXTRA_EPISODE_NAVIGATION_DIRECTION =
            "episodeNavigationDirection";
    static final String EPISODE_NAVIGATION_PREVIOUS = "previous";
    static final String EPISODE_NAVIGATION_NEXT = "next";
    public static final String ACTION_REQUEST_FRESH_STREAM =
            "tv.norva.phone.action.REQUEST_FRESH_STREAM";
    public static final String ACTION_APPLY_FRESH_STREAM =
            "tv.norva.phone.action.APPLY_FRESH_STREAM";
    public static final String EXTRA_RECOVERY_TOKEN = "recoveryToken";
    public static final String EXTRA_RECOVERY_PAYLOAD = "recoveryPayload";
    // Ephemeral launch bearer used once for first-frame truth. Long-lived lease
    // and terminal events obtain a current credential through the nonce-scoped
    // in-memory channel below; no refresh token enters this Activity.
    public static final String EXTRA_PLAYBACK_AUTH_TOKEN = "playbackAuthToken";
    public static final String EXTRA_PLAYBACK_SESSION_ID = "playbackSessionId";
    public static final String EXTRA_PLAYBACK_CLOSE_REASON = "playbackCloseReason";
    public static final String ACTION_REQUEST_PLAYBACK_AUTH =
            "tv.norva.phone.action.REQUEST_PLAYBACK_AUTH";
    public static final String ACTION_APPLY_PLAYBACK_AUTH =
            "tv.norva.phone.action.APPLY_PLAYBACK_AUTH";
    public static final String EXTRA_PLAYBACK_AUTH_CHANNEL_ID = "playbackAuthChannelId";
    public static final String EXTRA_PLAYBACK_AUTH_REQUEST_NONCE = "playbackAuthRequestNonce";
    /**
     * Debug-only first-frame fixture hook. Instrumentation supplies an opaque
     * token and listens for {@link #ACTION_FIRST_FRAME_TEST_RESULT}. Success is
     * emitted only from Media3's real onRenderedFirstFrame callback and includes
     * the actually selected video/audio MIME types.
     */
    public static final String EXTRA_FIRST_FRAME_TEST_TOKEN = "firstFrameTestToken";
    public static final String ACTION_FIRST_FRAME_TEST_RESULT =
            "tv.norva.phone.action.FIRST_FRAME_TEST_RESULT";
    public static final String EXTRA_FIRST_FRAME_TEST_OUTCOME = "outcome";
    public static final String EXTRA_FIRST_FRAME_TEST_VIDEO_MIME = "videoMime";
    public static final String EXTRA_FIRST_FRAME_TEST_AUDIO_MIME = "audioMime";
    public static final String EXTRA_FIRST_FRAME_TEST_CONTRACT_OK = "contractSatisfied";
    public static final String FIRST_FRAME_FIXTURE_VIDEO_MIME = "video/avc";
    public static final String FIRST_FRAME_FIXTURE_AUDIO_MIME = "audio/mp4a-latm";

    // IPTV providers gate on User-Agent and REJECT a browser UA (this provider 401s
    // it). Use the VLC UA the relay/gateway use successfully — the working default
    // for the whole stack (the cloud sends no UA, so the relay falls back to VLC).
    private static final String UA = "VLC/3.0.20 LibVLC/3.0.20";

    private ExoPlayer player;
    private MediaSession mediaSession;   // lock-screen / media-button transport controls
    private PlayerView playerView;
    enum PlaybackUiState {
        PREPARING,
        INITIAL_BUFFERING,
        RECOVERING,
        PLAYING,
        REBUFFERING,
        TERMINAL,
        OFFLINE
    }
    private PlaybackUiState playbackUiState = PlaybackUiState.PREPARING;
    private boolean engineReady = false;
    private boolean firstFrameForCurrentRoute = false;
    private boolean recoveryInProgress = false;
    private boolean longStartShown = false;
    private boolean longStartScheduled = false;
    private FrameLayout stateOverlay;
    private LinearLayout stateContent;
    private ImageView statePoster;
    private TextView stateTitleView;
    private TextView stateMessageView;
    private ProgressBar stateProgress;
    private TextView errorTitleView;
    private LinearLayout errorPanel;     // recoverable error UI (message + Retry + Back)
    private TextView errorView;          // the diagnostic detail line inside errorPanel
    private Button retryButton;
    private Button changeVersionButton;
    private Button errorBackButton;
    private final ExecutorService posterExecutor = Executors.newSingleThreadExecutor();
    private int posterLoadGeneration = 0;
    private String streamHost;           // host of the stream URL, included in the error text
    private String originalUrl;          // the first URL we tried, used to re-prepare on Retry
    private MediaItem originalMediaItem; // built once, replayed on Retry (carries the local MIME hint)
    private boolean isLocal = false;     // offline (encrypted local file) playback
    private String fallbackUrl;          // gateway URL to retry with on a direct-URL refusal
    private boolean fallbackTried = false;
    private int playRetries = 0;          // one in-place reconnect before asking JS for a fresh session
    private int recoveryGeneration = 0;   // invalidates delayed reconnects after a newer recovery action
    private int playbackRouteGeneration = 0;
    private String activePlaybackRouteId;
    private MediaItem pendingDelayedRecoveryItem;
    private long pendingDelayedRecoveryPositionMs;
    private boolean pendingDelayedRecovery;
    private int pendingDelayedRecoveryGeneration;
    private boolean everReady = false;    // direct or fallback reached STATE_READY at least once
    private boolean clarityPlaybackStarted = false;
    private boolean firstFrameRendered = false;
    private boolean firstFrameTelemetrySent = false;
    private long playbackLaunchElapsedMs;
    private String playbackAuthToken;
    private String playbackAuthChannelId;
    private String pendingPlaybackAuthRequestNonce;
    private String pendingPlaybackAuthPurpose;
    private String pendingTerminalTelemetryCode;
    private boolean pendingTerminalSawLongStart;
    private String pendingTerminalRecoveryReason;
    private String pendingTerminalRecoveryRoute;
    private int pendingTerminalRecoveryAttempt;
    private boolean pendingProviderBusyReport;
    private BroadcastReceiver playbackAuthReceiver;
    private String playbackSessionId;
    private boolean terminalTelemetrySent = false;
    private boolean sawLongStart = false;
    private String lastRecoveryReason = "none";
    private String lastRecoveryRoute = "direct";
    private int recoveryAttempt = 0;
    private long lastPlaybackHeartbeatElapsedMs = 0L;
    private String firstFrameTestToken;
    private boolean firstFrameTestResultEmitted;
    private boolean freshStreamRequested = false;
    private String freshStreamReason;
    private String recoveryToken;
    private BroadcastReceiver freshStreamReceiver;
    private String sourceId;
    private String itemType;
    private String itemId;
    private boolean playbackActive = false;
    private boolean resumePlaybackOnResume = false;
    private boolean freshStreamTimeoutDeferred = false;
    private boolean pipAutoEnterArmed = false;
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
    // A manual episode hand-off is returned to MainActivity only after this
    // Activity has stopped playback. MainActivity then waits for the exact
    // server-side session-close ACK before asking the WebView to resolve the
    // adjacent episode, preserving providers that allow a single stream.
    private String pendingEpisodeNavigationDirection;
    private TextView seekBubble;         // transient "+10s" / "🔆 60%" gesture feedback
    private View gestureTouchLayer;
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
    private String previousTitle;
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
    private android.widget.ImageButton previousEpisodeButton;
    private android.widget.ImageButton nextEpisodeButton;
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
    private static final String PLAYER_UI_PREFS = "norva_player_ui";
    private static final String PREF_VIDEO_RESIZE_MODE = "video_resize_mode_v1";
    private static final String VIDEO_RESIZE_MODE_FIT = "fit";
    private static final String VIDEO_RESIZE_MODE_FILL = "fill";
    private static final int MAX_EPISODE_LABEL_LENGTH = 180;

    private final Handler errHandler = new Handler(Looper.getMainLooper());
    private static final long BUFFER_TIMEOUT_MS = 35_000L; // "no data" watchdog
    private static final long LONG_START_MS = 8_000L;
    private static final long FRESH_STREAM_TIMEOUT_MS = 60_000L;
    // Poll faster than the server-side liveness write cadence so a superseded
    // native session stops within roughly 30 seconds without extending its lease.
    private static final long HEARTBEAT_INTERVAL_MS = 5_000L;
    private static final long PLAYBACK_AUTH_RESPONSE_TIMEOUT_MS = 5_000L;
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
    private final Runnable longStartNotice = new Runnable() {
        @Override public void run() {
            longStartScheduled = false;
            if (!shouldAllowPlayback(playbackActive, isInPipMode())) return;
            if (playbackUiState != PlaybackUiState.PREPARING
                    && playbackUiState != PlaybackUiState.INITIAL_BUFFERING
                    && playbackUiState != PlaybackUiState.RECOVERING) return;
            longStartShown = true;
            sawLongStart = true;
            renderPlaybackUiState(true);
        }
    };
    private final Runnable freshStreamTimeout = new Runnable() {
        @Override public void run() {
            if (!freshStreamRequested) return;
            if (!shouldAllowPlayback(playbackActive, isInPipMode())) {
                freshStreamTimeoutDeferred = true;
                return;
            }
            freshStreamRequested = false;
            freshStreamTimeoutDeferred = false;
            recoveryToken = null;
            rememberRecoverySignal("fresh_stream_timeout", "fresh", false);
            boolean formatFailure = isFormatRecoveryReason(freshStreamReason);
            boolean deviceOffline = !hasUsableNetwork();
            showPlaybackFailure(
                    formatFailure ? PlaybackUiState.TERMINAL : PlaybackUiState.OFFLINE,
                    formatFailure
                            ? R.string.player_state_terminal_title
                            : (deviceOffline
                                    ? R.string.player_state_offline_title
                                    : R.string.player_error_title),
                    formatFailure
                            ? getString(R.string.player_state_format_message)
                            : (deviceOffline
                                    ? getString(R.string.player_state_offline_message)
                                    : getString(R.string.player_reconnect_failed)),
                    formatFailure);
        }
    };
    private final Runnable playbackHeartbeat = new Runnable() {
        @Override public void run() {
            if (!shouldRunPlaybackHeartbeat()) return;
            requestPlaybackHeartbeatAuth();
            errHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };
    private final Runnable playbackAuthTimeout = new Runnable() {
        @Override public void run() {
            // Missing MainActivity, renderer stalls and refresh failures are all
            // fail-closed: skip this pulse and retry on the next normal cadence.
            clearPendingPlaybackAuthRequest();
            pendingProviderBusyReport = false;
        }
    };
    private final Runnable delayedRecovery = new Runnable() {
        @Override public void run() {
            if (!pendingDelayedRecovery) return;
            final MediaItem item = pendingDelayedRecoveryItem;
            final long positionMs = pendingDelayedRecoveryPositionMs;
            final int scheduledGeneration = pendingDelayedRecoveryGeneration;
            clearPendingDelayedRecovery();
            if (player == null || freshStreamRequested
                    || scheduledGeneration != recoveryGeneration) return;
            prepareMediaItem(item, positionMs, PlaybackUiState.RECOVERING);
        }
    };

    @OptIn(markerClass = UnstableApi.class)
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NativeClarity.configure(BuildConfig.CLARITY_PROJECT_ID, "android_mobile", BuildConfig.VERSION_NAME, BuildConfig.DEBUG ? "qa" : "production");
        NativeClarity.applyStoredConsent(this);
        NativeClarity.screen("player");
        NativeClarity.tag("journey_name", "time_to_value");
        NativeClarity.tag("journey_step", "playback");
        NativeClarity.event("content_opened");
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBackPressed);
        }
        playbackLaunchElapsedMs = SystemClock.elapsedRealtime();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        configureEdgeToEdgeWindow();

        String url = getIntent().getStringExtra(EXTRA_URL);
        mediaTitle = getIntent().getStringExtra(EXTRA_TITLE);
        sourceId = getIntent().getStringExtra(EXTRA_SOURCE_ID);
        itemType = getIntent().getStringExtra(EXTRA_ITEM_TYPE);
        itemId = getIntent().getStringExtra(EXTRA_ITEM_ID);
        preferenceScopeJson = getIntent().getStringExtra(EXTRA_PREFERENCE_SCOPE);
        cloudPlaybackPreferencesJson = getIntent().getStringExtra(EXTRA_PLAYBACK_PREFERENCES);
        posterUrl = getIntent().getStringExtra(EXTRA_POSTER_URL);
        previousTitle = boundedEpisodeLabel(
                getIntent().getStringExtra(EXTRA_PREVIOUS_TITLE));
        nextTitle = boundedEpisodeLabel(getIntent().getStringExtra(EXTRA_NEXT_TITLE));
        playbackAuthToken = getIntent().getStringExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        playbackAuthChannelId = getIntent().getStringExtra(EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
        if (!NativePlaybackAuthPolicy.validNonce(playbackAuthChannelId)) {
            playbackAuthChannelId = null;
        }
        playbackSessionId = NativePlaybackTelemetry.boundedSessionId(
                getIntent().getStringExtra(EXTRA_PLAYBACK_SESSION_ID));
        getIntent().removeExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        getIntent().removeExtra(EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
        getIntent().removeExtra(EXTRA_PLAYBACK_SESSION_ID);
        if (BuildConfig.DEBUG) {
            firstFrameTestToken = getIntent().getStringExtra(EXTRA_FIRST_FRAME_TEST_TOKEN);
        }
        getIntent().removeExtra(EXTRA_FIRST_FRAME_TEST_TOKEN);
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
        registerPlaybackAuthReceiver();
        try {
            String vj = getIntent().getStringExtra(EXTRA_VARIANTS);
            if (vj != null && !vj.isEmpty()) {
                org.json.JSONArray arr = new org.json.JSONArray(vj);
                if (arr.length() > 1) variants = arr;
            }
        } catch (Exception ignored) { variants = null; }

        playerView = new PlayerView(this);
        playerView.setId(R.id.norva_player_view);
        // The poster/status layer owns startup. Media3 remains fully inert until
        // a real first frame, so viewers never see a false Pause affordance or
        // a fabricated 00:00 timeline over a black surface.
        // A native video surface is cinematic black. The branded preparation
        // layer still owns loading and recovery, but playback itself must never
        // inherit a grey/navy cast around or over the decoded frame.
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        playerView.setBackgroundColor(Color.BLACK);
        playerView.setShutterBackgroundColor(Color.BLACK);
        // Phone video should occupy the physical display rather than look like
        // a smaller rectangle floating inside it. Keep the video's aspect ratio
        // and crop only the overflow; viewers can switch to the persisted
        // "fit entire video" mode from the explicit resize control or a pinch.
        applyStoredVideoResizeMode();
        playerView.setUseController(false);
        playerView.hideController();

        FrameLayout root = new FrameLayout(this);
        playerRoot = root;
        NativeClarity.registerSensitiveView(root);
        root.setId(R.id.norva_player_root);
        root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        root.setBackgroundColor(Color.BLACK);
        root.addView(playerView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        installPlaybackStateOverlay(root);
        installPlaybackErrorPanel(root);
        setContentView(root);
        loadPosterAsync();
        transitionTo(PlaybackUiState.PREPARING, false);

        // Video draws edge-to-edge beneath cutouts and transient system bars.
        // Only controller content receives safe insets; the decoded frame and
        // the PlayerView itself remain full-window.
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
                showPlaybackFailure(
                        PlaybackUiState.TERMINAL,
                        R.string.player_error_title,
                        getString(R.string.player_state_generic_terminal_message),
                        false,
                        false);
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
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory)
                        .setLoadErrorHandlingPolicy(new ProviderLoadErrorHandlingPolicy()))
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
                if (!ACTION_PIP_CONTROL.equals(intent.getAction()) || player == null
                        || !isControllerState(playbackUiState)
                        || !firstFrameForCurrentRoute) return;
                if ("pause".equals(intent.getStringExtra(EXTRA_PIP_ACTION))) player.pause();
                else player.play();
                refreshPipActions();
            }
        };
        try {
            ContextCompat.registerReceiver(
                    this,
                    pipReceiver,
                    new IntentFilter(ACTION_PIP_CONTROL),
                    ContextCompat.RECEIVER_NOT_EXPORTED);
        } catch (Exception ignored) { pipReceiver = null; }
        playerView.setKeepScreenOn(true);
        // Audio and subtitles now share one explicit Norva panel. Hiding the
        // separate stock CC button avoids two competing subtitle entry points;
        // the stock settings gear remains available for playback speed.
        playerView.setShowSubtitleButton(false);
        installGestureOverlay();
        installTopBar(root);
        installCompactBottomControls();
        installEpisodeNavigationControls();
        styleMedia3ControllerSurface();
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
                    engineReady = false;
                    // Arm the "no data" watchdog: a stream that connects but never
                    // delivers playable bytes would otherwise wait forever.
                    errHandler.removeCallbacks(bufferWatchdog);
                    if (shouldAllowPlayback(playbackActive, isInPipMode())) {
                        errHandler.postDelayed(bufferWatchdog, BUFFER_TIMEOUT_MS);
                    }
                    transitionTo(stateForBuffering(
                            recoveryInProgress, firstFrameRendered), false);
                }
                if (state == Player.STATE_READY) {
                    engineReady = true;
                    everReady = true;
                    if (firstFrameForCurrentRoute) {
                        // A normal rebuffer can return to READY without another
                        // onRenderedFirstFrame callback. Once this route has
                        // already painted, READY is sufficient evidence to
                        // retire the no-data watchdog.
                        errHandler.removeCallbacks(bufferWatchdog);
                    }
                    if (!resumeApplied && resumeSeconds > 0) {
                        resumeApplied = true;
                        long target = resumeSeconds * 1000L;
                        long duration = player.getDuration();
                        if (duration <= 0 || target < duration - 5000) {
                            player.seekTo(target);
                        }
                    }
                    // READY means the decoder can start, not that a picture has
                    // actually reached the display. Keep the honest poster/status
                    // layer until onRenderedFirstFrame proves the route.
                    PlaybackUiState readyState = stateAfterReady(
                            recoveryInProgress, firstFrameForCurrentRoute);
                    if (readyState == PlaybackUiState.PLAYING) {
                        recoveryInProgress = false;
                    }
                    transitionTo(readyState, false);
                }
                if (state == Player.STATE_ENDED) {
                    stopPlaybackHeartbeat();
                    errHandler.removeCallbacks(bufferWatchdog);
                    errHandler.removeCallbacks(longStartNotice);
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
                NativeClarity.tag("failure_family", "unknown");
                NativeClarity.event("journey_error");
                errHandler.removeCallbacks(bufferWatchdog);
                errHandler.removeCallbacks(longStartNotice);
                engineReady = false;
                int httpStatus = ProviderPlaybackPolicy.httpStatus(error);
                if (ProviderPlaybackPolicy.isProviderBusyHttpStatus(httpStatus)) {
                    android.util.Log.w("NorvaPlayer", "Provider account busy (HTTP 458)");
                    showProviderAccountConflict(true);
                    return;
                }
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
                boolean formatFailure = isFormatFailure(error);
                rememberRecoverySignal(
                        error.getErrorCodeName(),
                        fallbackTried ? "gateway" : "direct",
                        false);
                showPlaybackFailure(
                        PlaybackUiState.TERMINAL,
                        formatFailure
                                ? R.string.player_state_terminal_title
                                : R.string.player_error_title,
                        formatFailure
                                ? getString(R.string.player_state_format_message)
                                : friendlyPlaybackError(error),
                        formatFailure);
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                errHandler.removeCallbacks(healthyRecoveryReset);
                if (isPlaying) {
                    if (!clarityPlaybackStarted) {
                        clarityPlaybackStarted = true;
                        NativeClarity.event("playback_started");
                    }
                    if (firstFrameForCurrentRoute) {
                        errHandler.removeCallbacks(bufferWatchdog);
                    }
                    errHandler.postDelayed(healthyRecoveryReset, HEALTHY_RECOVERY_RESET_MS);
                    updatePlaybackHeartbeat();
                } else {
                    stopPlaybackHeartbeat();
                }
                if (firstFrameForCurrentRoute && engineReady) {
                    recoveryInProgress = false;
                    transitionTo(PlaybackUiState.PLAYING, false);
                }
                refreshPipActions(); // keep the PiP button icon in sync
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
        player.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onRenderedFirstFrame(
                    EventTime eventTime,
                    Object output,
                    long renderTimeMs
            ) {
                String eventRouteId = routeIdForEvent(eventTime);
                String currentRouteId = player == null || player.getCurrentMediaItem() == null
                        ? null
                        : player.getCurrentMediaItem().mediaId;
                if (!isFirstFrameForActiveRoute(
                        eventRouteId,
                        activePlaybackRouteId,
                        currentRouteId)) return;
                handleRenderedFirstFrame();
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
        if (!isLocal && !hasUsableNetwork()) {
            showPlaybackFailure(
                    PlaybackUiState.OFFLINE,
                    R.string.player_state_offline_title,
                    getString(R.string.player_state_offline_message),
                    false);
        } else {
            prepareMediaItem(originalMediaItem, 0L, PlaybackUiState.PREPARING);
        }
    }

    private void installPlaybackStateOverlay(FrameLayout root) {
        stateOverlay = new FrameLayout(this);
        stateOverlay.setId(R.id.norva_player_state_overlay);
        stateOverlay.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        stateOverlay.setBackgroundColor(color(R.color.norva_bg_primary));

        statePoster = new ImageView(this);
        statePoster.setId(R.id.norva_player_state_poster);
        statePoster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        statePoster.setAlpha(0.58f);
        statePoster.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        statePoster.setBackgroundColor(color(R.color.norva_bg_secondary));
        stateOverlay.addView(statePoster, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        View scrim = new View(this);
        GradientDrawable gradient = new GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                new int[] {
                        Color.parseColor("#FA080B12"),
                        Color.parseColor("#C7080B12"),
                        Color.parseColor("#40080B12")
                });
        scrim.setBackground(gradient);
        scrim.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        stateOverlay.addView(scrim, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        stateContent = new LinearLayout(this);
        stateContent.setId(R.id.norva_player_state_content);
        stateContent.setOrientation(LinearLayout.VERTICAL);
        stateContent.setGravity(Gravity.START);
        stateContent.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);

        stateTitleView = new TextView(this);
        stateTitleView.setId(R.id.norva_player_state_title);
        stateTitleView.setText(emptyToNull(mediaTitle) == null ? getString(R.string.app_name) : mediaTitle);
        stateTitleView.setTextColor(color(R.color.norva_text_primary));
        stateTitleView.setTextSize(24);
        stateTitleView.setMaxLines(2);
        stateTitleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        if (Build.VERSION.SDK_INT >= 28) stateTitleView.setAccessibilityHeading(true);
        stateContent.addView(stateTitleView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setOrientation(LinearLayout.HORIZONTAL);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams statusRowLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        statusRowLp.topMargin = dp(12);
        stateContent.addView(statusRow, statusRowLp);

        stateProgress = new ProgressBar(this);
        stateProgress.setId(R.id.norva_player_state_progress);
        stateProgress.setIndeterminate(true);
        stateProgress.setIndeterminateTintList(
                ColorStateList.valueOf(color(R.color.norva_accent)));
        statusRow.addView(stateProgress, new LinearLayout.LayoutParams(dp(28), dp(28)));

        stateMessageView = new TextView(this);
        stateMessageView.setId(R.id.norva_player_state_message);
        stateMessageView.setTextColor(color(R.color.norva_text_secondary));
        stateMessageView.setTextSize(15);
        stateMessageView.setMaxWidth(dp(620));
        stateMessageView.setMaxLines(3);
        LinearLayout.LayoutParams messageLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        messageLp.leftMargin = dp(12);
        statusRow.addView(stateMessageView, messageLp);

        FrameLayout.LayoutParams stateContentLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START);
        stateOverlay.addView(stateContent, stateContentLp);
        root.addView(stateOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void installPlaybackErrorPanel(FrameLayout root) {
        errorPanel = new LinearLayout(this);
        errorPanel.setId(R.id.norva_player_error_panel);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        errorPanel.setVisibility(View.GONE);

        errorTitleView = new TextView(this);
        errorTitleView.setId(R.id.norva_player_error_title);
        if (Build.VERSION.SDK_INT >= 28) errorTitleView.setAccessibilityHeading(true);
        errorTitleView.setText(getString(R.string.player_error_title));
        errorTitleView.setTextColor(color(R.color.norva_text_primary));
        errorTitleView.setTextSize(22);
        errorTitleView.setGravity(Gravity.CENTER);
        errorTitleView.setMaxLines(2);
        errorTitleView.setPadding(0, 0, 0, dp(12));
        errorPanel.addView(errorTitleView);

        errorView = new TextView(this);
        errorView.setId(R.id.norva_player_error_message);
        errorView.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        errorView.setTextColor(color(R.color.norva_text_secondary));
        errorView.setTextSize(15);
        errorView.setGravity(Gravity.CENTER);
        errorView.setMaxWidth(dp(560));
        errorView.setPadding(0, 0, 0, dp(24));
        errorPanel.addView(errorView);

        retryButton = playbackActionButton(
                R.id.norva_player_retry_button,
                R.string.player_retry,
                true,
                v -> retryPlayback());
        LinearLayout.LayoutParams retryLp = playbackActionLayoutParams();
        retryLp.bottomMargin = dp(12);
        errorPanel.addView(retryButton, retryLp);

        changeVersionButton = playbackActionButton(
                R.id.norva_player_change_version_button,
                R.string.player_change_version,
                true,
                v -> showVariantDialog());
        changeVersionButton.setVisibility(View.GONE);
        LinearLayout.LayoutParams changeLp = playbackActionLayoutParams();
        changeLp.bottomMargin = dp(12);
        errorPanel.addView(changeVersionButton, changeLp);

        errorBackButton = playbackActionButton(
                R.id.norva_player_error_back_button,
                R.string.player_back,
                false,
                v -> finishWithoutRecovery());
        errorPanel.addView(errorBackButton, playbackActionLayoutParams());

        root.addView(errorPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private Button playbackActionButton(
            int id,
            int label,
            boolean primary,
            View.OnClickListener listener
    ) {
        Button button = new Button(this);
        button.setId(id);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(220));
        button.setPadding(dp(20), 0, dp(20), 0);
        button.setTextColor(color(primary
                ? R.color.norva_bg_primary
                : R.color.norva_text_primary));
        button.setBackground(buttonBackground(
                color(primary ? R.color.norva_accent : R.color.norva_bg_tertiary),
                color(primary ? R.color.norva_accent_pressed : R.color.norva_border)));
        button.setOnClickListener(listener);
        return button;
    }

    private LinearLayout.LayoutParams playbackActionLayoutParams() {
        return new LinearLayout.LayoutParams(dp(240), dp(48));
    }

    private StateListDrawable buttonBackground(int normalColor, int pressedColor) {
        StateListDrawable states = new StateListDrawable();
        states.addState(
                new int[] { android.R.attr.state_pressed },
                roundedBackground(pressedColor, dp(10)));
        states.addState(new int[0], roundedBackground(normalColor, dp(10)));
        return states;
    }

    private GradientDrawable roundedBackground(int backgroundColor, int radiusPx) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(backgroundColor);
        drawable.setCornerRadius(radiusPx);
        return drawable;
    }

    private void transitionTo(PlaybackUiState next, boolean announce) {
        if (next == null) return;
        PlaybackUiState previous = playbackUiState;
        playbackUiState = next;

        boolean waiting = next == PlaybackUiState.PREPARING
                || next == PlaybackUiState.INITIAL_BUFFERING
                || next == PlaybackUiState.RECOVERING;
        if (waiting && !longStartShown && !longStartScheduled) {
            longStartScheduled = true;
            errHandler.postDelayed(longStartNotice, LONG_START_MS);
        } else if (!waiting) {
            errHandler.removeCallbacks(longStartNotice);
            longStartScheduled = false;
        }

        renderPlaybackUiState(announce || previous != next);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && (next == PlaybackUiState.PLAYING
                || previous == PlaybackUiState.PLAYING)) {
            refreshPipActions();
        }
        if (next == PlaybackUiState.PLAYING && previous != PlaybackUiState.PLAYING
                && playerView != null && !controlsLocked
                && !isInPipMode()) {
            playerView.showController();
        }
    }

    private void renderPlaybackUiState(boolean announce) {
        if (stateOverlay == null || playerView == null) return;
        boolean playable = isControllerState(playbackUiState);
        boolean failure = playbackUiState == PlaybackUiState.TERMINAL
                || playbackUiState == PlaybackUiState.OFFLINE;

        if (playbackUiState == PlaybackUiState.PLAYING) {
            stateOverlay.setVisibility(View.GONE);
            if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        } else {
            stateOverlay.setVisibility(View.VISIBLE);
            stateOverlay.bringToFront();
            if (statePoster != null) {
                statePoster.setVisibility(
                        playbackUiState == PlaybackUiState.REBUFFERING && firstFrameRendered
                                ? View.GONE
                                : View.VISIBLE);
            }
            if (stateContent != null) stateContent.setVisibility(failure ? View.GONE : View.VISIBLE);
            if (stateProgress != null) stateProgress.setVisibility(failure ? View.GONE : View.VISIBLE);
            if (errorPanel != null) {
                errorPanel.setVisibility(failure ? View.VISIBLE : View.GONE);
                if (failure) errorPanel.bringToFront();
            }
        }

        String message = messageForPlaybackUiState(playbackUiState);
        if (stateMessageView != null && !failure) stateMessageView.setText(message);
        if (stateTitleView != null) {
            stateTitleView.setText(emptyToNull(mediaTitle) == null
                    ? getString(R.string.app_name)
                    : mediaTitle);
        }

        boolean controllerEnabled = playable && !controlsLocked && !isInPipMode();
        playerView.setUseController(controllerEnabled);
        playerView.setImportantForAccessibility(playable
                ? View.IMPORTANT_FOR_ACCESSIBILITY_YES
                : View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        if (!controllerEnabled) {
            playerView.hideController();
            updateTrackButtonVisibility(false);
            updateTopBarVisibility(false);
            updateCompactControlVisibility(false);
        }
        if (gestureTouchLayer != null) {
            gestureTouchLayer.setEnabled(playable);
            gestureTouchLayer.setImportantForAccessibility(playable
                    ? View.IMPORTANT_FOR_ACCESSIBILITY_YES
                    : View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        if (announce && !failure && stateMessageView != null) {
            CharSequence title = emptyToNull(mediaTitle) == null
                    ? getString(R.string.app_name)
                    : mediaTitle;
            stateMessageView.announceForAccessibility(
                    getString(R.string.player_state_accessibility, title, message));
        }
    }

    private String messageForPlaybackUiState(PlaybackUiState state) {
        if (longStartShown && (state == PlaybackUiState.PREPARING
                || state == PlaybackUiState.INITIAL_BUFFERING
                || state == PlaybackUiState.RECOVERING)) {
            return getString(R.string.player_state_long_start);
        }
        switch (state) {
            case PREPARING:
                return getString(R.string.player_state_preparing);
            case INITIAL_BUFFERING:
                return getString(R.string.player_state_initial_buffering);
            case RECOVERING:
                return getString(R.string.player_state_recovering);
            case REBUFFERING:
                return getString(R.string.player_state_rebuffering);
            default:
                return "";
        }
    }

    static boolean isControllerState(PlaybackUiState state) {
        return state == PlaybackUiState.PLAYING || state == PlaybackUiState.REBUFFERING;
    }

    static PlaybackUiState stateForBuffering(
            boolean recovering,
            boolean anyFirstFrameRendered
    ) {
        if (recovering) return PlaybackUiState.RECOVERING;
        return anyFirstFrameRendered
                ? PlaybackUiState.REBUFFERING
                : PlaybackUiState.INITIAL_BUFFERING;
    }

    static PlaybackUiState stateAfterReady(
            boolean recovering,
            boolean firstFrameForRoute
    ) {
        if (firstFrameForRoute) return PlaybackUiState.PLAYING;
        return recovering
                ? PlaybackUiState.RECOVERING
                : PlaybackUiState.INITIAL_BUFFERING;
    }

    static boolean isFirstFrameForActiveRoute(
            String eventRouteId,
            String activeRouteId,
            String currentRouteId
    ) {
        return activeRouteId != null
                && activeRouteId.equals(eventRouteId)
                && activeRouteId.equals(currentRouteId);
    }

    static boolean shouldAllowPlayback(boolean playbackActive, boolean inPictureInPicture) {
        return playbackActive || inPictureInPicture;
    }

    private String routeIdForEvent(AnalyticsListener.EventTime eventTime) {
        if (eventTime == null || eventTime.timeline == null
                || eventTime.timeline.isEmpty()
                || eventTime.windowIndex < 0
                || eventTime.windowIndex >= eventTime.timeline.getWindowCount()) return null;
        try {
            Timeline.Window window = eventTime.timeline.getWindow(
                    eventTime.windowIndex,
                    new Timeline.Window());
            return window.mediaItem == null ? null : window.mediaItem.mediaId;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private void handleRenderedFirstFrame() {
        firstFrameForCurrentRoute = true;
        recoveryInProgress = false;
        errHandler.removeCallbacks(bufferWatchdog);
        errHandler.removeCallbacks(longStartNotice);
        transitionTo(PlaybackUiState.PLAYING, false);
        if (!firstFrameRendered) {
            firstFrameRendered = true;
            NativeClarity.event("playback_first_frame");
            recordNativeFirstFrame();
        }
        updatePlaybackHeartbeat();
    }

    private void prepareMediaItem(MediaItem item, long positionMs, PlaybackUiState state) {
        if (player == null || item == null) return;
        stopPlaybackHeartbeat();
        clearPendingDelayedRecovery();
        engineReady = false;
        firstFrameForCurrentRoute = false;
        recoveryInProgress = state == PlaybackUiState.RECOVERING;
        longStartShown = false;
        longStartScheduled = false;
        errHandler.removeCallbacks(longStartNotice);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        transitionTo(state, false);
        String routeId = "norva-route-" + (++playbackRouteGeneration);
        activePlaybackRouteId = routeId;
        MediaItem routedItem = item.buildUpon().setMediaId(routeId).build();
        player.setMediaItem(routedItem, Math.max(0L, positionMs));
        player.prepare();
        boolean mayPlay = shouldAllowPlayback(playbackActive, isInPipMode());
        player.setPlayWhenReady(mayPlay);
        if (!mayPlay) resumePlaybackOnResume = true;
    }

    private void showPlaybackFailure(
            PlaybackUiState state,
            int titleRes,
            String message,
            boolean recommendVersion
    ) {
        showPlaybackFailure(state, titleRes, message, recommendVersion, !recommendVersion);
    }

    private void showPlaybackFailure(
            PlaybackUiState state,
            int titleRes,
            String message,
            boolean recommendVersion,
            boolean retryAllowed
    ) {
        // A terminal/offline surface is authoritative. Invalidate every delayed
        // reconnect and recovery token so no stale runnable can restart playback
        // behind the error panel.
        recoveryGeneration++;
        freshStreamRequested = false;
        freshStreamTimeoutDeferred = false;
        recoveryToken = null;
        recoveryInProgress = false;
        engineReady = false;
        clearPendingDelayedRecovery();
        errHandler.removeCallbacks(bufferWatchdog);
        errHandler.removeCallbacks(longStartNotice);
        errHandler.removeCallbacks(freshStreamTimeout);
        stopPlaybackHeartbeat();
        longStartScheduled = false;
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { }
        }
        if (!terminalTelemetrySent) {
            terminalTelemetrySent = true;
            requestTerminalTelemetryAuth(
                    terminalTelemetryCode(state, recommendVersion));
        }
        if (errorTitleView != null) errorTitleView.setText(titleRes);
        if (errorView != null) {
            errorView.setText(message);
            errorView.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE);
        }
        boolean canChangeVersion = recommendVersion && variants != null && variants.length() > 1;
        if (retryButton != null) {
            retryButton.setVisibility(retryAllowed ? View.VISIBLE : View.GONE);
        }
        if (changeVersionButton != null) {
            changeVersionButton.setVisibility(canChangeVersion ? View.VISIBLE : View.GONE);
        }
        transitionTo(state, true);
        View focusTarget = canChangeVersion
                ? changeVersionButton
                : (retryAllowed ? retryButton : errorBackButton);
        if (focusTarget != null) {
            focusTarget.requestFocus();
            focusTarget.announceForAccessibility(
                    getString(R.string.player_state_accessibility,
                            getString(titleRes), message));
        }
        emitFirstFrameTestResult(
                state == PlaybackUiState.OFFLINE ? "offline" : "terminal",
                false);
        NativePlayerUiTelemetry.log(
                this,
                "player_error_action",
                "show",
                "error",
                state.name().toLowerCase(Locale.ROOT));
    }

    private void showProviderAccountConflict(boolean reportProviderBusy) {
        pendingProviderBusyReport = reportProviderBusy;
        rememberRecoverySignal("provider_busy", "direct", false);
        showPlaybackFailure(
                PlaybackUiState.TERMINAL,
                R.string.player_error_provider_in_use_title,
                getString(R.string.player_error_provider_in_use),
                false,
                true);
    }

    private void reportProviderBusy(String bearer) {
        NativePlaybackTelemetry.reportProviderBusy(bearer, playbackSessionId);
    }

    private boolean hasUsableNetwork() {
        if (isLocal) return true;
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network network = cm.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities capabilities = cm.getNetworkCapabilities(network);
            return capabilities == null
                    || capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Throwable ignored) {
            // A platform capability lookup must not reject a stream when the
            // provider URL itself can still prove connectivity.
            return true;
        }
    }

    private void loadPosterAsync() {
        if (statePoster == null) return;
        final int generation = ++posterLoadGeneration;
        final String remotePoster = emptyToNull(posterUrl);
        if (!isLocal && remotePoster == null) return;
        posterExecutor.execute(() -> {
            Bitmap bitmap = null;
            try {
                String localPoster = localPosterPath();
                if (localPoster != null) {
                    try (InputStream in = new FileInputStream(localPoster)) {
                        bitmap = decodePoster(readPosterBytes(in, 10 * 1024 * 1024));
                    }
                } else if (remotePoster.startsWith("https://")
                        || remotePoster.startsWith("http://")) {
                    HttpURLConnection connection = null;
                    try {
                        connection = (HttpURLConnection) new URL(remotePoster).openConnection();
                        connection.setConnectTimeout(5_000);
                        connection.setReadTimeout(7_000);
                        connection.setInstanceFollowRedirects(true);
                        connection.setRequestProperty("User-Agent", UA);
                        if (connection.getResponseCode() >= 200
                                && connection.getResponseCode() < 300) {
                            int length = connection.getContentLength();
                            if (length <= 10 * 1024 * 1024L) {
                                try (InputStream in = connection.getInputStream()) {
                                    bitmap = decodePoster(
                                            readPosterBytes(in, 10 * 1024 * 1024));
                                }
                            }
                        }
                    } finally {
                        if (connection != null) connection.disconnect();
                    }
                }
            } catch (Throwable ignored) {
                // The title/status fallback is complete without artwork.
            }
            final Bitmap loaded = bitmap;
            if (loaded == null) return;
            runOnUiThread(() -> {
                if (isFinishing() || generation != posterLoadGeneration
                        || statePoster == null) {
                    loaded.recycle();
                    return;
                }
                statePoster.setImageBitmap(loaded);
            });
        });
    }

    private String localPosterPath() {
        if (!isLocal || itemId == null || itemId.isEmpty()) return null;
        try {
            String id = (sourceId == null ? "" : sourceId) + ":" + itemId;
            DownloadStore.Item item = DownloadStore.get(this, id);
            if (item == null || emptyToNull(item.posterFile) == null) return null;
            File file = new File(item.posterFile);
            return file.isFile() ? file.getAbsolutePath() : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static byte[] readPosterBytes(InputStream input, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(maxBytes, 64 * 1024));
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) throw new IllegalArgumentException("poster too large");
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static Bitmap decodePoster(byte[] encoded) {
        if (encoded == null || encoded.length == 0) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(encoded, 0, encoded.length, bounds);
        int largest = Math.max(bounds.outWidth, bounds.outHeight);
        int sample = 1;
        while (largest / sample > 1600) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.RGB_565;
        return BitmapFactory.decodeByteArray(encoded, 0, encoded.length, options);
    }

    private int color(int colorRes) {
        return ContextCompat.getColor(this, colorRes);
    }

    /** Device-side truth that media actually rendered, emitted once per launch. */
    private void recordNativeFirstFrame() {
        if (firstFrameTelemetrySent) return;
        firstFrameTelemetrySent = true;
        NativePlaybackTelemetry.recordFirstFrame(
                playbackAuthToken, playbackSessionId, sourceId, itemType, itemId,
                Math.max(1L, SystemClock.elapsedRealtime() - playbackLaunchElapsedMs), isLocal);
        playbackAuthToken = null;
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
        emitFirstFrameTestResult("first_frame", true);
    }

    private boolean shouldRunPlaybackHeartbeat() {
        return !isLocal
                && NativePlaybackAuthPolicy.validNonce(playbackAuthChannelId)
                && NativePlaybackTelemetry.boundedSessionId(playbackSessionId) != null
                && player != null
                && player.isPlaying()
                && firstFrameForCurrentRoute
                && (playbackActive || isInPipMode())
                && !endedNaturally
                && playbackUiState != PlaybackUiState.TERMINAL
                && playbackUiState != PlaybackUiState.OFFLINE;
    }

    private void registerPlaybackAuthReceiver() {
        playbackAuthReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!ACTION_APPLY_PLAYBACK_AUTH.equals(intent.getAction())) return;
                acceptPlaybackAuth(intent);
            }
        };
        ContextCompat.registerReceiver(
                this,
                playbackAuthReceiver,
                new IntentFilter(ACTION_APPLY_PLAYBACK_AUTH),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private boolean requestPlaybackAuth(String purpose) {
        if (!NativePlaybackAuthPolicy.validNonce(playbackAuthChannelId)
                || pendingPlaybackAuthRequestNonce != null
                || !("heartbeat".equals(purpose) || "terminal".equals(purpose))) {
            return false;
        }
        String requestNonce = UUID.randomUUID().toString();
        pendingPlaybackAuthRequestNonce = requestNonce;
        pendingPlaybackAuthPurpose = purpose;
        errHandler.removeCallbacks(playbackAuthTimeout);
        errHandler.postDelayed(
                playbackAuthTimeout,
                PLAYBACK_AUTH_RESPONSE_TIMEOUT_MS);
        Intent request = new Intent(ACTION_REQUEST_PLAYBACK_AUTH)
                .setPackage(getPackageName())
                .putExtra(EXTRA_PLAYBACK_AUTH_CHANNEL_ID, playbackAuthChannelId)
                .putExtra(EXTRA_PLAYBACK_AUTH_REQUEST_NONCE, requestNonce);
        sendBroadcast(request);
        return true;
    }

    private void requestPlaybackHeartbeatAuth() {
        if (!shouldRunPlaybackHeartbeat()) return;
        requestPlaybackAuth("heartbeat");
    }

    private void requestTerminalTelemetryAuth(String terminalCode) {
        if (isLocal) return;
        // Terminal truth wins once playback has stopped. Preempt any pulse that
        // was waiting on WebView token rotation; MainActivity will replace its
        // pending nonce with the terminal request and reject the late pulse.
        boolean reportProviderBusy = pendingProviderBusyReport;
        clearPendingPlaybackAuthRequest();
        pendingProviderBusyReport = reportProviderBusy;
        pendingTerminalTelemetryCode = NativePlaybackTelemetry.boundedTerminalCode(
                terminalCode);
        pendingTerminalSawLongStart = sawLongStart;
        pendingTerminalRecoveryReason = NativePlaybackTelemetry.boundedRecoveryReason(
                lastRecoveryReason);
        pendingTerminalRecoveryRoute = NativePlaybackTelemetry.boundedRecoveryRoute(
                lastRecoveryRoute);
        pendingTerminalRecoveryAttempt = Math.max(0, Math.min(3, recoveryAttempt));
        if (!requestPlaybackAuth("terminal")) {
            clearPendingPlaybackAuthRequest();
            pendingProviderBusyReport = false;
        }
    }

    private void acceptPlaybackAuth(Intent intent) {
        if (intent == null || playbackAuthChannelId == null
                || pendingPlaybackAuthRequestNonce == null) return;
        String channelId = intent.getStringExtra(EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
        String requestNonce = intent.getStringExtra(EXTRA_PLAYBACK_AUTH_REQUEST_NONCE);
        if (!playbackAuthChannelId.equals(channelId)
                || !pendingPlaybackAuthRequestNonce.equals(requestNonce)) return;
        String bearer = intent.getStringExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        intent.removeExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        String purpose = pendingPlaybackAuthPurpose;
        String terminalCode = pendingTerminalTelemetryCode;
        boolean terminalSawLongStart = pendingTerminalSawLongStart;
        String terminalRecoveryReason = pendingTerminalRecoveryReason;
        String terminalRecoveryRoute = pendingTerminalRecoveryRoute;
        int terminalRecoveryAttempt = pendingTerminalRecoveryAttempt;
        boolean reportProviderBusy = pendingProviderBusyReport;
        pendingProviderBusyReport = false;
        clearPendingPlaybackAuthRequest();
        if ("heartbeat".equals(purpose)) {
            if (shouldRunPlaybackHeartbeat()) {
                lastPlaybackHeartbeatElapsedMs = SystemClock.elapsedRealtime();
                final String heartbeatSessionId = playbackSessionId;
                NativePlaybackTelemetry.recordHeartbeat(
                        bearer,
                        heartbeatSessionId,
                        resultCode -> {
                            if (!ProviderPlaybackPolicy.isPlaybackSuperseded(resultCode)) return;
                            runOnUiThread(() -> {
                                if (heartbeatSessionId != null
                                        && heartbeatSessionId.equals(playbackSessionId)
                                        && !isFinishing()) {
                                    showProviderAccountConflict(false);
                                }
                            });
                        });
            }
            return;
        }
        if ("terminal".equals(purpose)) {
            if (reportProviderBusy) {
                reportProviderBusy(bearer);
            }
            NativePlaybackTelemetry.recordTerminal(
                    bearer,
                    playbackSessionId,
                    sourceId,
                    itemType,
                    itemId,
                    terminalCode,
                    terminalSawLongStart,
                    terminalRecoveryReason,
                    terminalRecoveryRoute,
                    terminalRecoveryAttempt,
                    isLocal);
        }
    }

    private void clearPendingPlaybackAuthRequest() {
        errHandler.removeCallbacks(playbackAuthTimeout);
        pendingPlaybackAuthRequestNonce = null;
        pendingPlaybackAuthPurpose = null;
        pendingTerminalTelemetryCode = null;
        pendingTerminalSawLongStart = false;
        pendingTerminalRecoveryReason = null;
        pendingTerminalRecoveryRoute = null;
        pendingTerminalRecoveryAttempt = 0;
    }

    /**
     * Start the lease pulse immediately for a newly rendered session. Subsequent
     * lifecycle callbacks retain the 60-second cadence instead of duplicating
     * network requests when Android enters PiP moments after the first frame.
     */
    private void updatePlaybackHeartbeat() {
        stopPlaybackHeartbeat();
        if (!shouldRunPlaybackHeartbeat()) return;
        long elapsed = lastPlaybackHeartbeatElapsedMs == 0L
                ? HEARTBEAT_INTERVAL_MS
                : Math.max(0L,
                        SystemClock.elapsedRealtime() - lastPlaybackHeartbeatElapsedMs);
        if (elapsed >= HEARTBEAT_INTERVAL_MS) {
            errHandler.post(playbackHeartbeat);
        } else {
            errHandler.postDelayed(
                    playbackHeartbeat,
                    HEARTBEAT_INTERVAL_MS - elapsed);
        }
    }

    private void stopPlaybackHeartbeat() {
        errHandler.removeCallbacks(playbackHeartbeat);
        clearPendingPlaybackAuthRequest();
    }

    private void rememberRecoverySignal(String reason, String route, boolean newAttempt) {
        lastRecoveryReason = NativePlaybackTelemetry.boundedRecoveryReason(reason);
        lastRecoveryRoute = NativePlaybackTelemetry.boundedRecoveryRoute(route);
        if (newAttempt) {
            recoveryAttempt = Math.min(3, recoveryAttempt + 1);
        } else if (recoveryAttempt == 0 && !"none".equals(lastRecoveryReason)) {
            recoveryAttempt = 1;
        }
    }

    private String terminalTelemetryCode(
            PlaybackUiState state,
            boolean recommendVersion
    ) {
        if (recommendVersion) return "native_format";
        if (state == PlaybackUiState.OFFLINE) return "native_offline";
        if ("fresh_stream_timeout".equals(lastRecoveryReason)
                || "resolve_failed".equals(lastRecoveryReason)) {
            return "native_reconnect_failed";
        }
        return "native_terminal";
    }

    private void emitFirstFrameTestResult(String outcome, boolean rendered) {
        if (!BuildConfig.DEBUG || firstFrameTestResultEmitted
                || emptyToNull(firstFrameTestToken) == null) return;
        String videoMime = selectedMimeType(C.TRACK_TYPE_VIDEO);
        String audioMime = selectedMimeType(C.TRACK_TYPE_AUDIO);
        boolean contractSatisfied = isKnownGoodH264AacFirstFrameEvidence(
                rendered, videoMime, audioMime);
        firstFrameTestResultEmitted = true;
        Intent result = new Intent(ACTION_FIRST_FRAME_TEST_RESULT)
                .setPackage(getPackageName())
                .putExtra(EXTRA_FIRST_FRAME_TEST_TOKEN, firstFrameTestToken)
                .putExtra(EXTRA_FIRST_FRAME_TEST_OUTCOME, outcome)
                .putExtra(EXTRA_FIRST_FRAME_TEST_VIDEO_MIME, videoMime)
                .putExtra(EXTRA_FIRST_FRAME_TEST_AUDIO_MIME, audioMime)
                .putExtra(EXTRA_FIRST_FRAME_TEST_CONTRACT_OK, contractSatisfied)
                .putExtra("elapsedMs", Math.max(
                        0L, SystemClock.elapsedRealtime() - playbackLaunchElapsedMs));
        sendBroadcast(result);
    }

    private String selectedMimeType(int trackType) {
        if (player == null) return "";
        try {
            for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
                if (group.getType() != trackType) continue;
                for (int i = 0; i < group.length; i++) {
                    if (!group.isTrackSelected(i)) continue;
                    String mime = group.getTrackFormat(i).sampleMimeType;
                    return mime == null ? "" : mime;
                }
            }
        } catch (Throwable ignored) { }
        return "";
    }

    static boolean isKnownGoodH264AacFirstFrameEvidence(
            boolean rendered,
            String videoMime,
            String audioMime
    ) {
        return rendered
                && FIRST_FRAME_FIXTURE_VIDEO_MIME.equals(videoMime)
                && FIRST_FRAME_FIXTURE_AUDIO_MIME.equals(audioMime);
    }

    /** Map a download's container extension to a MIME type for the extractor. */
    private static String mimeForContainer(String container) {
        if (container == null) return null;
        switch (container.toLowerCase(Locale.ROOT)) {
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
     * Media3 ships a 60% full-controller scrim and an opaque bottom bar. They
     * visibly wash out the entire frame and make the player look inset even
     * though the video surface is already edge-to-edge. Keep the controller
     * structure and touch targets, but render its large surfaces transparent;
     * the white controls and time labels retain local text shadow for contrast.
     */
    private void styleMedia3ControllerSurface() {
        View controlsBackground = playerView.findViewById(
                androidx.media3.ui.R.id.exo_controls_background);
        View bottomBar = playerView.findViewById(androidx.media3.ui.R.id.exo_bottom_bar);
        View centerControls = playerView.findViewById(
                androidx.media3.ui.R.id.exo_center_controls);
        View time = playerView.findViewById(androidx.media3.ui.R.id.exo_time);
        for (View surface : new View[] { controlsBackground, bottomBar, centerControls, time }) {
            if (surface != null) surface.setBackgroundColor(Color.TRANSPARENT);
        }
        applyPlayerTextShadow(playerView.findViewById(androidx.media3.ui.R.id.exo_position));
        applyPlayerTextShadow(playerView.findViewById(androidx.media3.ui.R.id.exo_duration));
    }

    private void applyPlayerTextShadow(View view) {
        if (view instanceof TextView) {
            ((TextView) view).setShadowLayer(dp(2), 0, dp(1), Color.BLACK);
        }
    }

    static String boundedEpisodeLabel(String raw) {
        if (raw == null) return null;
        String normalized = raw.trim().replaceAll("[\\r\\n\\t]+", " ");
        if (normalized.isEmpty()) return null;
        return normalized.length() > MAX_EPISODE_LABEL_LENGTH
                ? normalized.substring(0, MAX_EPISODE_LABEL_LENGTH)
                : normalized;
    }

    static String boundedEpisodeNavigationDirection(String raw) {
        if (EPISODE_NAVIGATION_PREVIOUS.equals(raw)) {
            return EPISODE_NAVIGATION_PREVIOUS;
        }
        if (EPISODE_NAVIGATION_NEXT.equals(raw)) {
            return EPISODE_NAVIGATION_NEXT;
        }
        return null;
    }

    private boolean hasEpisodeNavigationContext() {
        boolean episode = "episode".equals(itemType) || "series".equals(itemType);
        return episode && (previousTitle != null || nextTitle != null);
    }

    private android.widget.ImageButton episodeNavigationButton(
            int id,
            int fallbackDrawable,
            int fallbackDescription,
            View stockButton,
            View.OnClickListener listener) {
        android.widget.ImageButton button = compactIconButton(
                id, fallbackDrawable, fallbackDescription, listener);
        if (stockButton instanceof ImageView
                && ((ImageView) stockButton).getDrawable() != null) {
            button.setImageDrawable(((ImageView) stockButton).getDrawable());
        }
        button.setFocusable(true);
        button.setVisibility(View.GONE);
        return button;
    }

    private void replaceMedia3NavigationButton(
            View stockButton, android.widget.ImageButton replacement) {
        if (stockButton == null || replacement == null) return;
        if (!(stockButton.getParent() instanceof android.view.ViewGroup)) {
            stockButton.setVisibility(View.GONE);
            return;
        }
        android.view.ViewGroup parent = (android.view.ViewGroup) stockButton.getParent();
        int index = Math.max(0, parent.indexOfChild(stockButton));
        stockButton.setVisibility(View.GONE);
        android.view.ViewGroup.LayoutParams layoutParams = parent instanceof LinearLayout
                ? new LinearLayout.LayoutParams(dp(48), dp(48))
                : new android.view.ViewGroup.LayoutParams(dp(48), dp(48));
        parent.addView(replacement, index, layoutParams);
    }

    /**
     * Replace Media3's single-item Previous/Next semantics with Norva episode
     * hand-offs. The playing Activity still owns one MediaItem and one provider
     * stream; the adjacent URL is deliberately unknown until this Activity has
     * returned and MainActivity has received the exact session-close ACK.
     */
    private void installEpisodeNavigationControls() {
        View stockPrevious = playerView.findViewById(androidx.media3.ui.R.id.exo_prev);
        View stockNext = playerView.findViewById(androidx.media3.ui.R.id.exo_next);
        if (stockPrevious == null || stockNext == null) return;

        previousEpisodeButton = episodeNavigationButton(
                R.id.norva_player_previous_episode_button,
                android.R.drawable.ic_media_previous,
                R.string.player_previous_episode,
                stockPrevious,
                v -> requestEpisodeNavigation(EPISODE_NAVIGATION_PREVIOUS));
        nextEpisodeButton = episodeNavigationButton(
                R.id.norva_player_next_episode_button,
                android.R.drawable.ic_media_next,
                R.string.player_next_episode,
                stockNext,
                v -> requestEpisodeNavigation(EPISODE_NAVIGATION_NEXT));
        replaceMedia3NavigationButton(stockPrevious, previousEpisodeButton);
        replaceMedia3NavigationButton(stockNext, nextEpisodeButton);
        updateEpisodeNavigationControls(false);
    }

    private void updateEpisodeNavigationControls(boolean controllerVisible) {
        if (previousEpisodeButton == null || nextEpisodeButton == null) return;
        boolean visible = hasEpisodeNavigationContext()
                && controllerVisible
                && !controlsLocked
                && isControllerState(playbackUiState);
        boolean idle = pendingEpisodeNavigationDirection == null;
        bindEpisodeNavigationButton(
                previousEpisodeButton,
                visible,
                idle && previousTitle != null,
                previousTitle,
                R.string.player_previous_episode,
                R.string.player_previous_episode_description,
                R.string.player_no_previous_episode);
        bindEpisodeNavigationButton(
                nextEpisodeButton,
                visible,
                idle && nextTitle != null,
                nextTitle,
                R.string.player_next_episode,
                R.string.player_next_episode_description,
                R.string.player_no_next_episode);
    }

    private void bindEpisodeNavigationButton(
            android.widget.ImageButton button,
            boolean visible,
            boolean enabled,
            String episodeLabel,
            int defaultDescription,
            int targetDescription,
            int unavailableDescription) {
        button.setVisibility(visible ? View.VISIBLE : View.GONE);
        button.setEnabled(enabled);
        button.setClickable(enabled);
        button.setFocusable(enabled);
        button.setAlpha(enabled ? 1f : 0.38f);
        button.setContentDescription(episodeLabel == null
                ? getString(unavailableDescription)
                : getString(targetDescription, episodeLabel));
        if (Build.VERSION.SDK_INT >= 26) {
            button.setTooltipText(episodeLabel == null
                    ? getString(defaultDescription)
                    : getString(targetDescription, episodeLabel));
        }
    }

    private void requestEpisodeNavigation(String rawDirection) {
        String direction = boundedEpisodeNavigationDirection(rawDirection);
        if (direction == null || pendingEpisodeNavigationDirection != null) return;
        String target = EPISODE_NAVIGATION_PREVIOUS.equals(direction)
                ? previousTitle : nextTitle;
        if (target == null) return;
        pendingEpisodeNavigationDirection = direction;
        if (player != null) player.pause();
        updateEpisodeNavigationControls(false);
        if (playerView != null) {
            playerView.announceForAccessibility(getString(
                    R.string.player_opening_episode, target));
        }
        NativePlayerUiTelemetry.log(this, "player_gesture", "tap",
                EPISODE_NAVIGATION_PREVIOUS.equals(direction)
                        ? "previous_episode" : "next_episode",
                "handoff");
        finish();
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
        updateResizeButtonDescription();
    }

    private void updateCompactControlVisibility(boolean controllerVisible) {
        boolean visible = controllerVisible && !controlsLocked
                && isControllerState(playbackUiState);
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
        updateEpisodeNavigationControls(controllerVisible);
    }

    private void applyStoredVideoResizeMode() {
        if (playerView == null) return;
        String mode = getSharedPreferences(PLAYER_UI_PREFS, MODE_PRIVATE)
                .getString(PREF_VIDEO_RESIZE_MODE, VIDEO_RESIZE_MODE_FILL);
        playerView.setResizeMode(VIDEO_RESIZE_MODE_FIT.equals(mode)
                ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
    }

    private void setVideoResizeMode(int resizeMode, boolean persist, boolean feedback) {
        if (playerView == null) return;
        int bounded = resizeMode == AspectRatioFrameLayout.RESIZE_MODE_FIT
                ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                : AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
        playerView.setResizeMode(bounded);
        if (persist) {
            getSharedPreferences(PLAYER_UI_PREFS, MODE_PRIVATE).edit()
                    .putString(PREF_VIDEO_RESIZE_MODE,
                            bounded == AspectRatioFrameLayout.RESIZE_MODE_FIT
                                    ? VIDEO_RESIZE_MODE_FIT
                                    : VIDEO_RESIZE_MODE_FILL)
                    .apply();
        }
        updateResizeButtonDescription();
        if (feedback) {
            showSeekFeedback(getString(
                    R.string.player_resize_feedback,
                    getString(bounded == AspectRatioFrameLayout.RESIZE_MODE_FIT
                            ? R.string.player_resize_fit
                            : R.string.player_resize_zoom)));
        }
    }

    private void updateResizeButtonDescription() {
        if (resizeButton == null || playerView == null) return;
        boolean filled = playerView.getResizeMode()
                == AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
        String current = getString(filled
                ? R.string.player_resize_zoom
                : R.string.player_resize_fit);
        String action = getString(filled
                ? R.string.player_resize_action_fit
                : R.string.player_resize_action_fill);
        resizeButton.setContentDescription(getString(
                R.string.player_resize_selected_description, current, action));
        if (Build.VERSION.SDK_INT >= 26) resizeButton.setTooltipText(action);
    }

    private void toggleResizeMode() {
        if (playerView == null) return;
        int next = playerView.getResizeMode() == AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                ? AspectRatioFrameLayout.RESIZE_MODE_FIT
                : AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
        setVideoResizeMode(next, true, true);
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
                // Never pad the whole Media3 controller: exo_center_controls is
                // centered inside that padded rectangle, so an asymmetric
                // landscape cutout shifts Play/Previous/Next away from the
                // decoded frame's physical centre. Keep the controller canvas
                // full-window and protect only the edge-bound controls below.
                controller.setPadding(0, 0, 0, 0);
            }
            View bottomBar = playerView.findViewById(
                    androidx.media3.ui.R.id.exo_bottom_bar);
            if (bottomBar != null) {
                bottomBar.setPadding(
                        safeInsetLeft, 0, safeInsetRight, safeInsetBottom);
            }
            View progress = playerView.findViewById(androidx.media3.ui.R.id.exo_progress);
            if (progress != null) {
                progress.setPadding(
                        safeInsetLeft,
                        progress.getPaddingTop(),
                        safeInsetRight,
                        progress.getPaddingBottom());
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
        if (stateContent != null) {
            stateContent.setPadding(
                    dp(32) + safeInsetLeft,
                    dp(24) + safeInsetTop,
                    dp(32) + safeInsetRight,
                    dp(32) + safeInsetBottom);
        }
        if (unlockBtn != null && unlockBtn.getLayoutParams() instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams unlockLp =
                    (FrameLayout.LayoutParams) unlockBtn.getLayoutParams();
            unlockLp.topMargin = dp(16) + safeInsetTop;
            unlockBtn.setLayoutParams(unlockLp);
        }
    }

    private void updateTopBarVisibility(boolean controllerVisible) {
        if (topBar != null) {
            topBar.setVisibility(controllerVisible && !controlsLocked
                    && isControllerState(playbackUiState) ? View.VISIBLE : View.GONE);
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
            freshStreamTimeoutDeferred = false;
            recoveryToken = null;
            clearPendingDelayedRecovery();
            playbackSessionId = NativePlaybackTelemetry.boundedSessionId(
                    payload.optString("sessionId", ""));
            lastPlaybackHeartbeatElapsedMs = 0L;
            rememberRecoverySignal(freshStreamReason, "fresh", false);
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
            originalMediaItem = new MediaItem.Builder().setUri(nextUrl).build();
            prepareMediaItem(
                    originalMediaItem,
                    requestedPosition,
                    PlaybackUiState.RECOVERING);
        } catch (Exception ignored) {
            freshStreamRequested = false;
            freshStreamTimeoutDeferred = false;
            recoveryToken = null;
            clearPendingDelayedRecovery();
            errHandler.removeCallbacks(freshStreamTimeout);
            rememberRecoverySignal("resolve_failed", "fresh", false);
            showPlaybackFailure(
                    PlaybackUiState.TERMINAL,
                    R.string.player_error_title,
                    getString(R.string.player_reconnect_failed),
                    false);
        }
    }

    private static String emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }

    private void finishWithoutRecovery() {
        freshStreamRequested = false;
        freshStreamTimeoutDeferred = false;
        recoveryToken = null;
        clearPendingDelayedRecovery();
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

    /** A manual retry must resolve a new provider/Gateway session, not reuse a stale signed URL. */
    private void retryPlayback() {
        NativePlayerUiTelemetry.log(this, "player_error_action", "retry", "error", "manual");
        if (!isLocal && !hasUsableNetwork()) {
            showPlaybackFailure(
                    PlaybackUiState.OFFLINE,
                    R.string.player_state_offline_title,
                    getString(R.string.player_state_offline_message),
                    false);
            return;
        }
        if (isLocal || sourceId == null || sourceId.isEmpty()
                || itemId == null || itemId.isEmpty()) {
            if (originalMediaItem != null) {
                prepareMediaItem(
                        originalMediaItem,
                        recoverPositionMs(),
                        PlaybackUiState.RECOVERING);
            }
            return;
        }
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

    private void clearPendingDelayedRecovery() {
        errHandler.removeCallbacks(delayedRecovery);
        pendingDelayedRecovery = false;
        pendingDelayedRecoveryItem = null;
        pendingDelayedRecoveryPositionMs = 0L;
        pendingDelayedRecoveryGeneration = 0;
    }

    private void scheduleDelayedRecovery(
            MediaItem item,
            long positionMs,
            int scheduledGeneration
    ) {
        clearPendingDelayedRecovery();
        pendingDelayedRecovery = true;
        pendingDelayedRecoveryItem = item;
        pendingDelayedRecoveryPositionMs = Math.max(0L, positionMs);
        pendingDelayedRecoveryGeneration = scheduledGeneration;
        errHandler.postDelayed(delayedRecovery, 1_500L);
    }

    /**
     * Recover without ejecting the viewer: retry the proven current route once,
     * then try the Gateway fallback, then ask the web layer to resolve a brand-new
     * session. The retry budget resets only after 60 seconds of healthy playback,
     * preventing rapid READY/EOF loops from retrying forever.
     */
    private void recoverPlayback(final String reason) {
        NativeClarity.tag("journey_outcome", "retry");
        NativeClarity.event("journey_retry");
        if (player == null || freshStreamRequested) return;
        rememberRecoverySignal(reason, fallbackTried ? "gateway" : "direct", true);
        final int scheduledGeneration = ++recoveryGeneration;
        recoveryInProgress = true;
        engineReady = false;
        errHandler.removeCallbacks(bufferWatchdog);
        errHandler.removeCallbacks(healthyRecoveryReset);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        transitionTo(PlaybackUiState.RECOVERING, true);

        if (!shouldAllowPlayback(playbackActive, isInPipMode())) {
            resumePlaybackOnResume = true;
            MediaItem current = player.getCurrentMediaItem();
            scheduleDelayedRecovery(
                    current != null ? current : originalMediaItem,
                    recoverPositionMs(),
                    scheduledGeneration);
            // Background lifecycle removes the runnable but deliberately keeps
            // this exact route/position for a foreground-only resume.
            errHandler.removeCallbacks(delayedRecovery);
            return;
        }

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
            MediaItem item = current != null ? current : new MediaItem.Builder()
                    .setUri(fallbackTried && fallbackUrl != null ? fallbackUrl : originalUrl)
                    .build();
            scheduleDelayedRecovery(item, position, scheduledGeneration);
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
        clearPendingDelayedRecovery();
        if (!isLocal && !hasUsableNetwork()) {
            showPlaybackFailure(
                    PlaybackUiState.OFFLINE,
                    R.string.player_state_offline_title,
                    getString(R.string.player_state_offline_message),
                    false);
            return;
        }
        if (isLocal || sourceId == null || sourceId.isEmpty()
                || itemId == null || itemId.isEmpty()) {
            showPlaybackFailure(
                    PlaybackUiState.TERMINAL,
                    R.string.player_error_title,
                    getString(R.string.player_state_generic_terminal_message),
                    false);
            return;
        }
        freshStreamRequested = true;
        freshStreamTimeoutDeferred = false;
        recoveryInProgress = true;
        engineReady = false;
        firstFrameForCurrentRoute = false;
        freshStreamReason = reason == null ? "playback_interrupted" : reason;
        rememberRecoverySignal(freshStreamReason, "fresh", false);
        recoveryToken = UUID.randomUUID().toString();
        long position = recoverPositionMs();
        long duration = player != null && player.getDuration() > 0
                ? player.getDuration() : 0L;
        transitionTo(PlaybackUiState.RECOVERING, true);
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
        if (shouldAllowPlayback(playbackActive, isInPipMode())) {
            errHandler.postDelayed(freshStreamTimeout, FRESH_STREAM_TIMEOUT_MS);
        } else {
            freshStreamTimeoutDeferred = true;
            resumePlaybackOnResume = true;
        }
    }

    /** Reload from the gateway fallback URL after a direct-URL refusal (e.g. provider 401). */
    private void switchToFallback() {
        recoveryGeneration++;
        clearPendingDelayedRecovery();
        fallbackTried = true;
        rememberRecoverySignal(lastRecoveryReason, "gateway", false);
        playRetries = 0;              // one fresh in-place retry budget for the fallback URL
        trackPreferencesApplied = false;
        streamHost = hostOf(fallbackUrl);
        errHandler.removeCallbacks(bufferWatchdog);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        prepareMediaItem(
                new MediaItem.Builder().setUri(fallbackUrl).build(),
                recoverPositionMs(),
                PlaybackUiState.RECOVERING);
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

    private static boolean isFormatFailure(PlaybackException e) {
        if (e == null) return false;
        int code = e.errorCode;
        return code >= PlaybackException.ERROR_CODE_DECODING_FAILED
                && code <= PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES;
    }

    static boolean isFormatRecoveryReason(String reason) {
        if (reason == null) return false;
        return reason.contains("PARSING_CONTAINER_UNSUPPORTED")
                || reason.contains("PARSING_MANIFEST_UNSUPPORTED")
                || reason.contains("DECODING_FORMAT_UNSUPPORTED")
                || reason.contains("DECODING_FORMAT_EXCEEDS_CAPABILITIES");
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
    @SuppressLint("ClickableViewAccessibility")
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
                if (!isControllerState(playbackUiState)) return false;
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
                if (!isControllerState(playbackUiState)) return true;
                if (controlsLocked) { flashUnlockButton(); return true; }
                if (gestureTouchLayer != null) gestureTouchLayer.performClick();
                return true;
            }

            @Override public boolean onDoubleTap(MotionEvent e) {
                if (player == null || controlsLocked
                        || !isControllerState(playbackUiState)) return false;
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
                if (controlsLocked || !isControllerState(playbackUiState)
                        || (scaleDetector != null && scaleDetector.isInProgress())) return false;
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
                if (!controlsLocked && isControllerState(playbackUiState)) {
                    if (pinchAccum > 1.15f) {
                        setVideoResizeMode(
                                AspectRatioFrameLayout.RESIZE_MODE_ZOOM, true, true);
                        NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                                "pinch", "resize", "zoom");
                    } else if (pinchAccum < 0.87f) {
                        setVideoResizeMode(
                                AspectRatioFrameLayout.RESIZE_MODE_FIT, true, true);
                        NativePlayerUiTelemetry.log(PlayerActivity.this, "player_gesture",
                                "pinch", "resize", "fit");
                    }
                }
                pinchAccum = 1f;
            }
        });

        gestureTouchLayer = new View(this);
        gestureTouchLayer.setId(R.id.norva_player_controls);
        gestureTouchLayer.setContentDescription(getString(R.string.player_show_controls));
        gestureTouchLayer.setEnabled(isControllerState(playbackUiState));
        gestureTouchLayer.setImportantForAccessibility(isControllerState(playbackUiState)
                ? View.IMPORTANT_FOR_ACCESSIBILITY_YES
                : View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        gestureTouchLayer.setOnClickListener(v -> {
            // Accessibility services activate this surface as a normal click.
            if (!isControllerState(playbackUiState) || controlsLocked) return;
            if (playerView.isControllerFullyVisible()) playerView.hideController();
            else playerView.showController();
        });
        gestureTouchLayer.setOnTouchListener((v, ev) -> {
            scaleDetector.onTouchEvent(ev);
            boolean handled = detector.onTouchEvent(ev);
            if (ev.getAction() == MotionEvent.ACTION_UP) {
                verticalDragMode = 0;
            }
            return handled;
        });
        overlay.addView(gestureTouchLayer, new FrameLayout.LayoutParams(
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
        unlockBtn.setAllCaps(false);
        unlockBtn.setMinHeight(dp(48));
        unlockBtn.setPadding(dp(20), 0, dp(20), 0);
        unlockBtn.setTextColor(color(R.color.norva_text_primary));
        unlockBtn.setBackground(buttonBackground(
                Color.parseColor("#E612121A"),
                color(R.color.norva_bg_tertiary)));
        unlockBtn.setVisibility(View.GONE);
        unlockBtn.setOnClickListener(v -> setControlsLocked(false));
        FrameLayout.LayoutParams unlockLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        unlockLp.topMargin = dp(16) + safeInsetTop;
        overlay.addView(unlockBtn, unlockLp);
    }

    private void setControlsLocked(boolean locked) {
        if (locked && !isControllerState(playbackUiState)) return;
        controlsLocked = locked;
        playerView.setUseController(!locked && isControllerState(playbackUiState));
        if (locked) {
            playerView.hideController();
            if (lockBtn != null) lockBtn.setVisibility(View.GONE);
            updateTrackButtonVisibility(false);
            updateTopBarVisibility(false);
            updateCompactControlVisibility(false);
            flashUnlockButton();
        } else {
            if (unlockBtn != null) {
                unlockBtn.removeCallbacks(hideUnlockBtn);
                unlockBtn.setVisibility(View.GONE);
            }
            if (isControllerState(playbackUiState)) {
                playerView.showController();
                updateTrackButtonVisibility(true);
                updateTopBarVisibility(true);
                updateCompactControlVisibility(true);
            }
        }
        playerView.announceForAccessibility(getString(locked
                ? R.string.player_controls_locked
                : R.string.player_controls_unlocked));
    }

    /** While locked, a tap reveals the unlock pill for a few seconds. */
    private void flashUnlockButton() {
        if (unlockBtn == null || !controlsLocked || !isControllerState(playbackUiState)) return;
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
                        prepareMediaItem(
                                new MediaItem.Builder().setUri(localUrl).build(),
                                resumePositionMs > 0 && !"channel".equals(itemType)
                                        ? resumePositionMs : 0L,
                                PlaybackUiState.RECOVERING);
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

    private void configureEdgeToEdgeWindow() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
    }

    /** Immersive fullscreen: hide the status and navigation bars (sticky, so a
     *  swipe reveals them transiently without resizing the video). */
    private void applyImmersive() {
        configureEdgeToEdgeWindow();
        if (Build.VERSION.SDK_INT >= 30) {
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

    private void deactivatePlaybackForBackground() {
        stopPlaybackHeartbeat();
        boolean wasActive = playbackActive;
        playbackActive = false;
        pipAutoEnterArmed = false;
        if (player != null) {
            resumePlaybackOnResume = resumePlaybackOnResume
                    || player.getPlayWhenReady()
                    || recoveryInProgress
                    || pendingDelayedRecovery
                    || freshStreamRequested;
        }
        if (wasActive) recoveryGeneration++;
        errHandler.removeCallbacks(bufferWatchdog);
        errHandler.removeCallbacks(delayedRecovery);
        errHandler.removeCallbacks(healthyRecoveryReset);
        errHandler.removeCallbacks(longStartNotice);
        errHandler.removeCallbacks(freshStreamTimeout);
        freshStreamTimeoutDeferred = freshStreamRequested;
        longStartScheduled = false;
        if (player != null) player.pause();
    }

    private void resumePlaybackAfterForegroundReturn() {
        if (player == null) return;
        if (pendingDelayedRecovery) {
            MediaItem deferredItem = pendingDelayedRecoveryItem;
            long deferredPositionMs = pendingDelayedRecoveryPositionMs;
            clearPendingDelayedRecovery();
            resumePlaybackOnResume = false;
            if (deferredItem != null) {
                prepareMediaItem(
                        deferredItem,
                        deferredPositionMs,
                        PlaybackUiState.RECOVERING);
            }
        } else if (freshStreamRequested) {
            // The provider socket was deliberately stopped while a token-bound
            // replacement is being resolved. Never reopen that stale URL merely
            // because the Activity returned to the foreground.
            resumePlaybackOnResume = false;
        } else if (resumePlaybackOnResume
                && playbackUiState != PlaybackUiState.TERMINAL
                && playbackUiState != PlaybackUiState.OFFLINE) {
            resumePlaybackOnResume = false;
            player.play();
        }

        if (freshStreamRequested && freshStreamTimeoutDeferred) {
            freshStreamTimeoutDeferred = false;
            errHandler.removeCallbacks(freshStreamTimeout);
            errHandler.postDelayed(freshStreamTimeout, FRESH_STREAM_TIMEOUT_MS);
        }
        if (player.getPlaybackState() == Player.STATE_BUFFERING) {
            errHandler.removeCallbacks(bufferWatchdog);
            errHandler.postDelayed(bufferWatchdog, BUFFER_TIMEOUT_MS);
        }
        boolean waiting = playbackUiState == PlaybackUiState.PREPARING
                || playbackUiState == PlaybackUiState.INITIAL_BUFFERING
                || playbackUiState == PlaybackUiState.RECOVERING;
        if (waiting && !longStartShown) {
            longStartScheduled = false;
            transitionTo(playbackUiState, false);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        playbackActive = true;
        pipAutoEnterArmed = false;
        resumePlaybackAfterForegroundReturn();
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
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Pre-Android 13 fallback. Android 13+ dispatches to the registered
        // OnBackInvokedCallback, which is mandatory once targetSdk reaches 36.
        handleBackPressed();
    }

    private void handleBackPressed() {
        if (trackDialog != null) {
            trackDialog.dismiss();
            return;
        }
        // A locked player consumes Back once to restore controls. Exiting while
        // the viewer is explicitly locked is surprising and makes the lock feel
        // unreliable; a second Back still leaves normally.
        if (controlsLocked) {
            setControlsLocked(false);
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

    private String playbackCloseReason() {
        if (endedNaturally) return "ended";
        if (pendingEpisodeNavigationDirection != null) {
            return "episode_navigation";
        }
        if (pendingVariantStreamId != null && !pendingVariantStreamId.isEmpty()) {
            return "variant_change";
        }
        if (freshStreamRequested) return "recovery_abandoned";
        if (playbackUiState == PlaybackUiState.OFFLINE) return "offline";
        if (playbackUiState == PlaybackUiState.TERMINAL) return "terminal";
        return "closed";
    }

    @Override
    protected void onStop() {
        super.onStop();
        persistPendingProgress();
        if (!isInPipMode()) {
            stopPlaybackHeartbeat();
            deactivatePlaybackForBackground();
        } else {
            updatePlaybackHeartbeat();
        }
    }

    /**
     * Hand the final position back to MainActivity, which persists it to the
     * cloud history for cross-device resume. Runs on every exit path.
     */
    @Override
    public void finish() {
        stopPlaybackHeartbeat();
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
            if (pendingEpisodeNavigationDirection != null) {
                if (data == null) data = new Intent();
                data.putExtra("sourceId", sourceId);
                data.putExtra("itemType", itemType);
                data.putExtra("itemId", itemId);
                data.putExtra(
                        EXTRA_EPISODE_NAVIGATION_DIRECTION,
                        pendingEpisodeNavigationDirection);
            }
            if (playbackSessionId != null) {
                if (data == null) data = new Intent();
                data.putExtra(EXTRA_PLAYBACK_SESSION_ID, playbackSessionId);
                data.putExtra(EXTRA_PLAYBACK_CLOSE_REASON, playbackCloseReason());
            }
            if (playbackAuthChannelId != null) {
                if (data == null) data = new Intent();
                data.putExtra(EXTRA_PLAYBACK_AUTH_CHANNEL_ID, playbackAuthChannelId);
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
        stopPlaybackHeartbeat();
        // Android 12 auto-enter reports onPause immediately before PiP becomes
        // observable. Keep that one transition alive; every other background
        // path cancels recovery work and cannot restart playback.
        boolean inPip = isInPipMode();
        boolean enteringAutoPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && pipAutoEnterArmed;
        if (!inPip && !enteringAutoPip) deactivatePlaybackForBackground();
    }

    // Picture-in-Picture: when the user leaves (Home / recents) while a video is
    // playing, shrink into a PiP window and keep playing.
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        persistPendingProgress();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (player == null || !player.isPlaying()
                || playbackUiState != PlaybackUiState.PLAYING
                || !firstFrameForCurrentRoute) return;
        try {
            PictureInPictureParams params = buildPipParams();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+ enters automatically with a continuous animation.
                // The params are also refreshed whenever play state changes.
                pipAutoEnterArmed = true;
                setPictureInPictureParams(params);
            } else {
                enterPictureInPictureMode(params);
            }
        } catch (Exception ignored) { }
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
        if (playerView != null) {
            Rect sourceRect = new Rect();
            if (playerView.getGlobalVisibleRect(sourceRect) && !sourceRect.isEmpty()) {
                b.setSourceRectHint(sourceRect);
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setAutoEnterEnabled(player != null
                    && player.isPlaying()
                    && playbackUiState == PlaybackUiState.PLAYING
                    && firstFrameForCurrentRoute);
        }
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
                    new RemoteAction(
                            icon,
                            getString(playing
                                    ? R.string.player_pip_pause
                                    : R.string.player_pip_play),
                            getString(R.string.player_pip_play_pause),
                            pi)));
        } catch (Exception ignored) { /* actions are optional */ }
        return b.build();
    }

    /** Re-issue the PiP params so the play/pause button reflects the new state. */
    private void refreshPipActions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || isInPipMode()) {
                setPictureInPictureParams(buildPipParams());
            }
        } catch (Exception ignored) { }
    }

    private boolean isInPipMode() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                && isInPictureInPictureMode();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPip, newConfig);
        pipAutoEnterArmed = false;
        if (isInPip) {
            playbackActive = true;
            updatePlaybackHeartbeat();
        }
        if (playerView != null) {
            // No transport UI inside the tiny PiP window.
            playerView.setUseController(!isInPip && !controlsLocked
                    && isControllerState(playbackUiState));
            if (isInPip) playerView.hideController();
            else renderPlaybackUiState(false);
        }
    }

    @Override
    protected void onDestroy() {
        stopPlaybackHeartbeat();
        pendingPlaybackAuthRequestNonce = null;
        playbackAuthChannelId = null;
        playbackAuthToken = null;
        playbackSessionId = null;
        lastPlaybackHeartbeatElapsedMs = 0L;
        firstFrameTestToken = null;
        playbackActive = false;
        pipAutoEnterArmed = false;
        resumePlaybackOnResume = false;
        freshStreamTimeoutDeferred = false;
        clearPendingDelayedRecovery();
        posterLoadGeneration++;
        posterExecutor.shutdownNow();
        errHandler.removeCallbacksAndMessages(null);
        if (freshStreamReceiver != null) {
            try { unregisterReceiver(freshStreamReceiver); } catch (Exception ignored) { }
            freshStreamReceiver = null;
        }
        if (playbackAuthReceiver != null) {
            try { unregisterReceiver(playbackAuthReceiver); } catch (Exception ignored) { }
            playbackAuthReceiver = null;
        }
        if (trackDialog != null) { trackDialog.dismiss(); trackDialog = null; }
        if (pipReceiver != null) { try { unregisterReceiver(pipReceiver); } catch (Exception ignored) { } pipReceiver = null; }
        if (castSupport != null) { castSupport.stop(); castSupport = null; }
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        if (player != null) { player.release(); player = null; }
        if (statePoster != null) {
            statePoster.setImageDrawable(null);
            statePoster = null;
        }
        super.onDestroy();
    }
}
