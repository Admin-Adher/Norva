package tv.norva.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.annotation.OptIn;
import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.SubtitleView;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Standalone-mode native player (ExoPlayer / media3) with a TiviMate-style
 * on-screen display:
 *   - top-right clock,
 *   - title + full-width seek bar,
 *   - circular transport row matching the web player (-10s / play-pause / +10s),
 *   - a chevron that expands a second options bar: video/resolution, audio
 *     track, subtitles, aspect ratio, playback speed and sleep timer.
 *
 * Built entirely in code (no media3-ui) so the APK assembles with raw SDK
 * tools and stays small.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {

    private static final String TAG = "NorvaPlayer";

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SOURCE_ID = "sourceId";
    public static final String EXTRA_ITEM_TYPE = "itemType";
    public static final String EXTRA_ITEM_ID = "itemId";
    public static final String EXTRA_RESUME_SECONDS = "resumeSeconds";
    // Gateway byte-pipe URL to retry with if the direct provider URL is refused
    // (e.g. the provider 401s this device's residential IP).
    public static final String EXTRA_FALLBACK_URL = "fallbackUrl";
    // Next-episode label ("S2 E5 — Titre") for the end-of-stream "À suivre" overlay.
    // Absent → end-of-stream simply closes the player (movies, live).
    public static final String EXTRA_NEXT_TITLE = "nextTitle";
    // Live quality variants: a JSON array of {label, streamId, sourceId} for the same
    // logical channel (M6 HD/RAW/HEVC...), plus the currently-playing streamId. Present
    // only for multi-variant live channels; drives the "Version" control. Picking one
    // returns it to MainActivity (selectedVariantStreamId), which asks the web to
    // re-resolve + relaunch that variant (a live gateway grants one slot, so we can't
    // just swap the source in place).
    public static final String EXTRA_VARIANTS = "variants";
    public static final String EXTRA_ACTIVE_VARIANT = "activeStreamId";
    public static final String EXTRA_TRACK_METADATA = "trackMetadata";
    public static final String EXTRA_PREFERENCE_SCOPE = "preferenceScope";
    public static final String EXTRA_PLAYBACK_PREFERENCES = "playbackPreferences";
    public static final String ACTION_REQUEST_FRESH_STREAM =
            "tv.norva.tv.action.REQUEST_FRESH_STREAM";
    public static final String ACTION_APPLY_FRESH_STREAM =
            "tv.norva.tv.action.APPLY_FRESH_STREAM";
    public static final String ACTION_CANCEL_FRESH_STREAM =
            "tv.norva.tv.action.CANCEL_FRESH_STREAM";
    public static final String EXTRA_RECOVERY_TOKEN = "recoveryToken";
    public static final String EXTRA_RECOVERY_PAYLOAD = "recoveryPayload";
    public static final String EXTRA_PLAYBACK_AUTH_TOKEN = "playbackAuthToken";

    // IPTV providers gate on User-Agent and REJECT a browser UA (this provider 401s
    // it). Use the VLC UA the relay/gateway use successfully — the working default
    // for the whole stack (the cloud sends no UA, so the relay falls back to VLC).
    private static final String UA = "VLC/3.0.20 LibVLC/3.0.20";

    private static final int ACCENT = Color.parseColor("#818CF8");
    private static final int PANEL = Color.parseColor("#CC0A0A0F");
    private static final int SUBTLE = Color.parseColor("#B4B4C0");

    private ExoPlayer player;
    private MediaSession mediaSession; // Assistant voice transport + now-playing card
    private SurfaceView surfaceView;
    private SubtitleView subtitleView;
    private ProgressBar spinner;
    private TextView errorView;
    private LinearLayout errorPanel;
    private TextView errorTitleView;
    private TextView errorMessageView;

    private FrameLayout root;
    private FrameLayout overlay;
    private TextView clockView;
    private TextView titleView;
    private TextView timeView;
    private SeekBar seekBar;
    private ImageButton playPauseBtn;
    private LinearLayout secondBar;
    private ImageButton chevron;

    // Second-bar value labels (kept to refresh after a change)
    private TextView videoValue;
    private TextView audioValue;
    private TextView subValue;
    private TextView aspectValue;
    private TextView speedValue;
    private TextView sleepValue;
    private LinearLayout primaryActions;
    private ImageButton audioButton;
    private ImageButton subtitleButton;
    private ImageButton aspectButton;
    private ImageButton moreButton;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean controlsVisible = true;
    private boolean secondBarVisible = false;
    private boolean userSeeking = false;

    private int videoW = 0, videoH = 0;
    private int playRetries = 0; // one reconnect of the active lane before changing transport
    private int recoveryGeneration = 0; // invalidates delayed reconnects after a newer recovery action
    private int aspectMode = 0; // 0 fit, 1 zoom (crop)
    private final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};
    private int speedIndex = 2;
    private int sleepMinutes = 0;
    private final int[] SLEEP_OPTIONS = {0, 15, 30, 60, 90};
    private int sleepIndex = 0;
    private String sourceId;
    private String itemType;
    private String itemId;
    private boolean playbackOkReported = false;
    private int resumeSeconds = 0;        // start offset for cross-device resume
    private boolean resumeApplied = false; // seek to the resume offset only once
    private String subKey;                 // SharedPreferences key for the subtitle choice
    private boolean subPrefRestored = false; // apply the saved subtitle pref only once
    private String streamHost;               // host of the stream URL, diagnostics only
    private String originalUrl;               // residential/direct URL used again after a healthy mid-stream stall
    private String fallbackUrl;              // gateway URL to retry with on a direct-URL refusal
    private boolean fallbackTried = false;
    private boolean everReady = false;        // direct or fallback reached STATE_READY at least once
    private boolean firstFrameRendered = false;
    private long playbackLaunchElapsedMs;
    private String playbackAuthToken;
    private boolean freshStreamRequested = false;
    private String freshStreamReason;
    private String recoveryToken;
    private String cancelledRecoveryTokenForResult;
    private long pendingRecoveryPositionMs;
    private BroadcastReceiver freshStreamReceiver;
    private String preferenceScopeJson;
    private String cloudPlaybackPreferencesJson;
    private org.json.JSONArray verifiedAudioTracks;
    private org.json.JSONArray exactSubtitleTracks;
    private PlaybackPreferenceStore preferenceStore;
    private PlaybackPreferenceStore.Scope preferenceScope;
    private PlaybackPreferenceStore.Preferences resolvedTrackPreferences =
            PlaybackPreferenceStore.Preferences.empty();
    private boolean audioPreferenceDirty;
    private boolean subtitlePreferenceDirty;
    private boolean trackPreferencesApplied;
    private TrackOption pendingTrackSelection;
    private boolean pendingSubtitleOff;
    // Keep the viewer's play/pause intent separate from lifecycle pauses. A
    // delayed reconnect or fresh-session response may arrive after HOME/Back;
    // it may prepare media there, but it must never restart audio in the
    // background unless this Activity is actually in PiP.
    private boolean activityForeground = false;
    private boolean userWantsPlayback = true;
    private boolean applyingLifecyclePlaybackState = false;
    private static final long BUFFER_TIMEOUT_MS = 35_000L; // "no data" watchdog
    private static final long HEALTHY_RECOVERY_RESET_MS = 60_000L;
    // A live feed is an open-ended socket: some panels close an otherwise healthy
    // connection every few minutes. That is not an end-of-program and must never
    // pop the viewer back to the guide. Keep reconnecting inside this Activity,
    // with a bounded backoff, until the provider resumes or the viewer presses Back.
    private static final long[] LIVE_RECONNECT_DELAYS_MS = {
            1_000L, 2_000L, 3_500L, 5_000L, 8_000L, 12_000L, 15_000L
    };
    private int liveReconnectAttempts = 0;
    private final Runnable healthyRecoveryReset = new Runnable() {
        @Override public void run() { playRetries = 0; }
    };

    // End-of-stream: "À suivre" overlay (series binge) and exit reporting.
    private String nextTitle;                 // next-episode label, null for movies/live
    private org.json.JSONArray variants;      // live quality variants, null for single-variant/movies
    private String activeStreamId;            // currently-playing variant's streamId
    private String pendingVariantStreamId;    // set when the viewer picks a variant → returned on finish()
    private String pendingVariantSourceId;
    private boolean endedNaturally = false;   // reached STATE_ENDED (vs user close)
    private boolean playNextChosen = false;   // viewer picked (or countdown chose) next episode
    private boolean openEpisodesChosen = false; // viewer asked for the episode list (fiche)
    private LinearLayout nextPanel;           // the overlay itself, built lazily
    private TextView nextCountdownView;
    private int nextCountdownSecs;
    private final Runnable nextCountdownTick = new Runnable() {
        @Override
        public void run() {
            nextCountdownSecs--;
            if (nextCountdownSecs <= 0) { chooseNextEpisode(); return; }
            if (nextCountdownView != null) {
                nextCountdownView.setText("Playing in " + nextCountdownSecs + "s");
            }
            handler.postDelayed(this, 1000);
        }
    };

    private final SimpleDateFormat clockFmt = new SimpleDateFormat("EEE d MMM · HH:mm", Locale.ENGLISH);

    // Keyboard scrubbing: arrows adjust a pending target shown live on the bar,
    // and the actual seek is committed shortly after the last press (so holding
    // the arrow scrubs smoothly instead of firing dozens of seeks).
    private long pendingSeekTarget = -1;
    private final Runnable commitSeekRunnable = new Runnable() {
        @Override
        public void run() { commitPendingSeek(); }
    };

    private final Runnable hideControlsRunnable = new Runnable() {
        @Override
        public void run() { hideControls(); }
    };

    // H1 fix: the native player otherwise hands back a position only on graceful
    // finish(), so a power-off / standby / crash mid-playback loses the whole
    // session. We persist the live position to SharedPreferences on a ~10s
    // heartbeat and on onPause/onStop; MainActivity flushes any pending position
    // to cloud history on its next foreground (see flushPendingNativeProgress).
    private long lastProgressPersistMs = 0L;
    // Throttle for the in-playback cloud relay (via MainActivity's WebView) — coarser than the
    // local 10s persist: cross-device visibility needs ~45s, not a request per tick.
    private long lastCloudRelayMs = 0L;
    private boolean gracefulResultEmitted = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            updateProgress();
            updateClock();
            maybePersistProgress(false);
            handler.postDelayed(this, 500);
        }
    };

    private final Runnable sleepRunnable = new Runnable() {
        @Override
        public void run() { finish(); }
    };

    // A stream that connects but never delivers playable bytes (single-slot provider
    // busy, a residential-IP refusal that dangles the socket, a dead link) sits in
    // STATE_BUFFERING and throws NO PlaybackException — so it never reaches the
    // onPlayerError recovery ladder. Drive the SAME recovery from here: switch to the
    // gateway fallback once, then a single re-prepare (the provider frees its lone slot
    // ~8s after the prior connection drops), and only then surface + report the error.
    private final Runnable bufferWatchdog = new Runnable() {
        @Override
        public void run() {
            recoverPlayback("no_data_timeout");
        }
    };

    private final Runnable freshStreamTimeout = new Runnable() {
        @Override public void run() {
            if (!freshStreamRequested) return;
            clearFreshStreamRequest(true);
            spinner.setVisibility(View.GONE);
            showActionableError(
                    getString(R.string.player_error_title),
                    getString(R.string.player_reconnect_failed));
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        playbackLaunchElapsedMs = android.os.SystemClock.elapsedRealtime();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        sourceId = getIntent().getStringExtra(EXTRA_SOURCE_ID);
        itemType = getIntent().getStringExtra(EXTRA_ITEM_TYPE);
        itemId = getIntent().getStringExtra(EXTRA_ITEM_ID);
        preferenceScopeJson = getIntent().getStringExtra(EXTRA_PREFERENCE_SCOPE);
        cloudPlaybackPreferencesJson = getIntent().getStringExtra(EXTRA_PLAYBACK_PREFERENCES);
        playbackAuthToken = getIntent().getStringExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        getIntent().removeExtra(EXTRA_PLAYBACK_AUTH_TOKEN);
        resumeSeconds = getIntent().getIntExtra(EXTRA_RESUME_SECONDS, 0);
        subKey = subKeyFor(itemType, itemId);
        if (url == null || url.isEmpty()) { finish(); return; }
        originalUrl = url;
        streamHost = hostOf(url);
        fallbackUrl = getIntent().getStringExtra(EXTRA_FALLBACK_URL);
        nextTitle = getIntent().getStringExtra(EXTRA_NEXT_TITLE);
        activeStreamId = getIntent().getStringExtra(EXTRA_ACTIVE_VARIANT);
        readTrackMetadata(getIntent().getStringExtra(EXTRA_TRACK_METADATA));
        initializePlaybackPreferences(true);
        registerFreshStreamReceiver();
        try {
            String vj = getIntent().getStringExtra(EXTRA_VARIANTS);
            if (vj != null && !vj.isEmpty()) {
                org.json.JSONArray arr = new org.json.JSONArray(vj);
                if (arr.length() > 1) variants = arr;
            }
        } catch (Exception ignored) { variants = null; }

        root = new FrameLayout(this);
        root.setId(R.id.norva_tv_player_root);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        surfaceView = new SurfaceView(this);
        surfaceView.setId(R.id.norva_tv_player_surface);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));

        subtitleView = new SubtitleView(this);
        subtitleView.setId(R.id.norva_tv_player_subtitles);
        subtitleView.setApplyEmbeddedStyles(true);
        subtitleView.setApplyEmbeddedFontSizes(true);
        subtitleView.setViewType(SubtitleView.VIEW_TYPE_CANVAS);
        subtitleView.setBottomPaddingFraction(0.08f);
        subtitleView.setVisibility(View.GONE);
        FrameLayout.LayoutParams subLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER);
        root.addView(subtitleView, subLp);

        spinner = new ProgressBar(this);
        root.addView(spinner, new FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER));

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#ef4444"));
        errorView.setTextSize(17);
        errorView.setGravity(Gravity.CENTER);
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        buildOverlay(title);
        buildActionableErrorPanel();
        buildPlayer(url);

        handler.post(tick);
        scheduleHideControls();
    }

    // ==================== ExoPlayer ====================

    private void buildPlayer(String url) {
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(UA)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000);
        // Bound open-ended seek ranges so Resume jumps straight to the offset
        // instead of the provider replaying the file from byte 0 (a ~20s stall).
        DataSource.Factory dataSourceFactory = new BoundedRangeDataSource.Factory(http);

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))
                .build();
        player.setVideoSurfaceView(surfaceView);
        // MediaSession: Assistant voice transport ("mets pause", "reprends"), the
        // Android TV now-playing card and hardware transport keys drive the player.
        try { mediaSession = new MediaSession.Builder(this, player).build(); } catch (Exception ignored) { }

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                spinner.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                if (state == Player.STATE_BUFFERING) {
                    // Arm the "no data" watchdog; cancel it on any other state.
                    handler.removeCallbacks(bufferWatchdog);
                    handler.postDelayed(bufferWatchdog, BUFFER_TIMEOUT_MS);
                } else {
                    handler.removeCallbacks(bufferWatchdog);
                }
                if (state == Player.STATE_READY) {
                    everReady = true;
                    liveReconnectAttempts = 0;
                    errorView.setVisibility(View.GONE);
                    if (errorPanel != null) errorPanel.setVisibility(View.GONE);
                    reportPlaybackStatus("ok", null);
                    if (player.getDuration() > 0) {
                        seekBar.setMax((int) (player.getDuration() / 1000));
                    }
                    // Cross-device resume: jump to the saved offset once the
                    // player is ready (only once, and never past the end).
                    if (!resumeApplied && resumeSeconds > 0) {
                        resumeApplied = true;
                        long target = resumeSeconds * 1000L;
                        long dur = player.getDuration();
                        if (dur <= 0 || target < dur - 5000) {
                            player.seekTo(target);
                        }
                    }
                    refreshSecondBarValues();
                }
                if (state == Player.STATE_ENDED) {
                    if (isPrematureEnd()) recoverPlayback("premature_end");
                    else onStreamEnded();
                }
                updatePlayPauseLabel();
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                handler.removeCallbacks(healthyRecoveryReset);
                if (isPlaying) handler.postDelayed(healthyRecoveryReset, HEALTHY_RECOVERY_RESET_MS);
                updatePlayPauseLabel();
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                // MediaSession / hardware transport commands are user intent.
                // Lifecycle-gated pauses use the guard so they do not turn an
                // intended resume into a permanent pause.
                if (!applyingLifecyclePlaybackState
                        && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST) {
                    userWantsPlayback = playWhenReady;
                    // MediaSession mutates ExoPlayer before this callback. A
                    // hardware Play received while backgrounded must be
                    // recorded as intent but immediately forced back through
                    // the foreground/PiP gate.
                    applyPlaybackIntent();
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                if (!firstFrameRendered) {
                    firstFrameRendered = true;
                    final String authToken = playbackAuthToken;
                    playbackAuthToken = null;
                    NativePlaybackTelemetry.recordFirstFrame(authToken, sourceId, itemType, itemId,
                            Math.max(1L, android.os.SystemClock.elapsedRealtime()
                                    - playbackLaunchElapsedMs));
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                handler.removeCallbacks(bufferWatchdog);
                final int code = error.errorCode;
                final String diagnostic = diagnose(error);
                // Keep provider/ExoPlayer internals available to support without
                // exposing hosts, exception classes or stack details on the TV.
                android.util.Log.w(TAG, diagnostic, error);
                // Transient network/HTTP errors (incl. a 504 or a briefly held
                // single-connection slot) AND container/manifest parsing errors: a
                // single-slot panel answering "busy" with a non-media body on HTTP 200
                // surfaces as PARSING_CONTAINER_* — contention, not a broken file
                // (2026-07-18 VOD incident). Retry both before giving up; decode/DRM
                // errors stay terminal (retrying can't fix those).
                boolean recoverable = code >= PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                        && code <= PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED;
                // Direct provider play can be refused for this device's residential IP
                // (e.g. HTTP 401/403) or unreachable, while the cloud gateway IP is
                // accepted. Switch to the gateway fallback once before retrying/erroring.
                if (recoverable) {
                    recoverPlayback(error.getErrorCodeName());
                    return;
                }
                spinner.setVisibility(View.GONE);
                showActionableError(
                        getString(R.string.player_error_title),
                        friendlyError(code));
                // Only the bounded error code leaves this Activity. diagnose(error)
                // can contain provider URLs/credentials and stays in Logcat.
                reportPlaybackStatus("broken", error.getErrorCodeName());
            }

            @Override
            public void onVideoSizeChanged(VideoSize videoSize) {
                videoW = videoSize.width;
                videoH = videoSize.height;
                applyAspect();
                refreshSecondBarValues();
            }

            @Override
            public void onCues(CueGroup cueGroup) {
                subtitleView.setCues(cueGroup.cues);
                subtitleView.setVisibility(cueGroup.cues.isEmpty() ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                if (!trackPreferencesApplied) {
                    trackPreferencesApplied = true;
                    if (applyResolvedTrackPreferences(tracks)) {
                        refreshSecondBarValues();
                        return;
                    }
                }
                confirmPendingTrackSelection(tracks);
                refreshSecondBarValues();
            }
        });

        playRetries = 0;
        player.setMediaItem(MediaItem.fromUri(url));
        player.prepare();
        applyPlaybackIntent();
    }

    private void reportPlaybackStatus(final String status, final String reason) {
        if (sourceId == null || itemType == null || itemId == null
                || sourceId.isEmpty() || itemType.isEmpty() || itemId.isEmpty()) return;
        if ("ok".equals(status) && playbackOkReported) return;
        if ("ok".equals(status)) playbackOkReported = true;

        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    JSONObject body = new JSONObject()
                            .put("sourceId", sourceId)
                            .put("itemType", itemType)
                            .put("itemId", itemId)
                            .put("status", status);
                    if (reason != null) body.put("reason", reason);

                    URL endpoint = new URL("http://127.0.0.1:" + LocalServer.PORT + "/api/playback-status/report");
                    conn = (HttpURLConnection) endpoint.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    conn.setDoOutput(true);
                    byte[] data = body.toString().getBytes("UTF-8");
                    conn.getOutputStream().write(data);
                    conn.getResponseCode();
                } catch (Exception e) {
                    android.util.Log.w("PlayerActivity", "playback status report failed", e);
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }, "norva-playback-status").start();
    }

    /** Map ExoPlayer errors to concise, actionable copy; technical details stay in Logcat. */
    private String friendlyError(int code) {
        final boolean live = isLiveContent();
        if (code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) {
            return live
                    ? "This channel is temporarily unavailable.\nNorva will reconnect automatically."
                    : "This title is temporarily unavailable from the provider.\nTry another version or try again in a moment.";
        }
        if (code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) {
            return live
                    ? "Live TV was interrupted.\nNorva will reconnect automatically."
                    : "The connection was interrupted.\nTry again in a moment.";
        }
        if (code == PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
                || code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED
                || code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED) {
            return live
                    ? "This channel is not sending playable video right now.\nNorva will keep trying automatically."
                    : "This version is not sending playable video right now.\nTry another available version.";
        }
        if (code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED) {
            return live
                    ? "This channel uses a format this TV cannot play.\nTry another version of the channel."
                    : "This version uses a format this TV cannot play.\nTry another available version.";
        }
        return live
                ? "This channel cannot be played right now.\nTry another version or try again later."
                : "Playback was interrupted.\nTry again or choose another version.";
    }

    private void buildActionableErrorPanel() {
        errorPanel = new LinearLayout(this);
        errorPanel.setId(R.id.norva_tv_player_error_panel);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(48), dp(36), dp(48), dp(36));
        GradientDrawable panelBackground = new GradientDrawable();
        panelBackground.setColor(Color.parseColor("#EE0A0A0F"));
        panelBackground.setCornerRadius(dp(18));
        errorPanel.setBackground(panelBackground);
        errorPanel.setVisibility(View.GONE);
        errorPanel.setFocusable(true);

        errorTitleView = new TextView(this);
        errorTitleView.setId(R.id.norva_tv_player_error_title);
        errorTitleView.setTextColor(Color.WHITE);
        errorTitleView.setTextSize(26);
        errorTitleView.setGravity(Gravity.CENTER);
        errorTitleView.setPadding(0, 0, 0, dp(10));
        errorPanel.addView(errorTitleView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        errorMessageView = new TextView(this);
        errorMessageView.setId(R.id.norva_tv_player_error_message);
        errorMessageView.setTextColor(SUBTLE);
        errorMessageView.setTextSize(18);
        errorMessageView.setGravity(Gravity.CENTER);
        errorMessageView.setPadding(0, 0, 0, dp(22));
        errorPanel.addView(errorMessageView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        TextView retry = errorAction(
                R.id.norva_tv_player_retry_button,
                getString(R.string.player_retry),
                new Runnable() {
                    @Override public void run() { retryPlayback(); }
                });
        TextView back = errorAction(
                R.id.norva_tv_player_error_back_button,
                getString(R.string.player_error_back),
                new Runnable() {
                    @Override public void run() { finishWithoutRecovery(); }
                });
        LinearLayout.LayoutParams actionLp = new LinearLayout.LayoutParams(dp(190), dp(56));
        actionLp.leftMargin = dp(8);
        actionLp.rightMargin = dp(8);
        actions.addView(retry, new LinearLayout.LayoutParams(actionLp));
        actions.addView(back, new LinearLayout.LayoutParams(actionLp));
        errorPanel.addView(actions);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                Math.min(dp(720), getResources().getDisplayMetrics().widthPixels - dp(120)),
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        root.addView(errorPanel, lp);
    }

    private TextView errorAction(int id, String label, final Runnable action) {
        TextView button = new TextView(this);
        button.setId(id);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(17);
        button.setGravity(Gravity.CENTER);
        button.setContentDescription(label);
        makeFocusable(button, 0);
        button.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { action.run(); }
        });
        return button;
    }

    private void showActionableError(String title, String message) {
        spinner.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        if (errorPanel == null) return;
        errorTitleView.setText(title);
        errorMessageView.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        errorPanel.bringToFront();
        if (errorPanel.getChildCount() > 2) {
            View actions = errorPanel.getChildAt(2);
            if (actions instanceof ViewGroup && ((ViewGroup) actions).getChildCount() > 0) {
                ((ViewGroup) actions).getChildAt(0).requestFocus();
            }
        }
    }

    private void retryPlayback() {
        boolean restoreControlsFocus = controlsVisible
                && overlay != null && overlay.getVisibility() == View.VISIBLE;
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        if (isLiveContent()) {
            liveReconnectAttempts = 0;
            playRetries = 0;
            scheduleLiveReconnect("manual_retry");
        } else {
            clearFreshStreamRequest(true);
            requestFreshStream("manual_retry");
        }
        if (restoreControlsFocus && playPauseBtn != null) {
            showControls(playPauseBtn);
            playPauseBtn.requestFocus();
        }
    }

    /** Compact, shareable technical detail from a playback failure (code, HTTP status, cause, host). */
    private String diagnose(PlaybackException e) {
        StringBuilder sb = new StringBuilder("Details: ").append(e.getErrorCodeName());
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

    // ==================== End of stream / "À suivre" ====================

    /**
     * Natural end of the stream. Series episodes with a known follower get a
     * Netflix-style "À suivre" overlay (10 s countdown, Lire maintenant /
     * Retour); everything else closes the player, reporting `ended` so the web
     * layer can chain its own autoplay.
     */
    private void onStreamEnded() {
        endedNaturally = true;
        if (nextTitle != null && !nextTitle.isEmpty() && nextPanel == null) {
            showNextEpisodePanel();
        } else if (nextPanel == null) {
            finish();
        }
    }

    private void showNextEpisodePanel() {
        hideOverlayNow();
        handler.removeCallbacks(hideControlsRunnable);

        nextPanel = new LinearLayout(this);
        nextPanel.setOrientation(LinearLayout.VERTICAL);
        nextPanel.setBackgroundColor(PANEL);
        nextPanel.setPadding(dp(28), dp(20), dp(28), dp(20));

        TextView kicker = new TextView(this);
        kicker.setText("Up next");
        kicker.setTextColor(SUBTLE);
        kicker.setTextSize(14);
        nextPanel.addView(kicker);

        TextView titleView = new TextView(this);
        titleView.setText(nextTitle);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(20);
        titleView.setPadding(0, dp(4), 0, dp(4));
        nextPanel.addView(titleView);

        nextCountdownView = new TextView(this);
        nextCountdownView.setTextColor(ACCENT);
        nextCountdownView.setTextSize(15);
        nextCountdownView.setPadding(0, 0, 0, dp(14));
        nextPanel.addView(nextCountdownView);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        nextPanel.addView(buttons);

        android.widget.Button playBtn = new android.widget.Button(this);
        playBtn.setText("▶  Play now");
        playBtn.setTextColor(Color.parseColor("#0A0A0F"));
        playBtn.setBackgroundColor(Color.parseColor("#E4E4F2"));
        playBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { chooseNextEpisode(); }
        });
        LinearLayout.LayoutParams playLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        playLp.rightMargin = dp(12);
        buttons.addView(playBtn, playLp);

        android.widget.Button backBtn = new android.widget.Button(this);
        backBtn.setText("Back");
        backBtn.setTextColor(Color.WHITE);
        backBtn.setBackgroundColor(Color.parseColor("#33FFFFFF"));
        backBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { cancelNextPanel(); }
        });
        buttons.addView(backBtn);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.END);
        lp.rightMargin = dp(48);
        lp.bottomMargin = dp(48);
        root.addView(nextPanel, lp);

        nextCountdownSecs = 10;
        nextCountdownView.setText("Playing in " + nextCountdownSecs + "s");
        handler.postDelayed(nextCountdownTick, 1000);
        playBtn.requestFocus();
    }

    /** Close with playNext so MainActivity asks the web layer to launch the follower. */
    private void chooseNextEpisode() {
        playNextChosen = true;
        handler.removeCallbacks(nextCountdownTick);
        finish();
    }

    private void cancelNextPanel() {
        handler.removeCallbacks(nextCountdownTick);
        finish();
    }

    private boolean isLiveContent() {
        return "channel".equals(itemType) || "live".equals(itemType);
    }

    /**
     * A provider EOF is not a natural end for live. For VOD, require a rendered
     * frame and a position close to the declared duration before marking watched
     * or launching the next episode.
     */
    private boolean isPrematureEnd() {
        if (isLiveContent()) return true;
        if (!firstFrameRendered || player == null) return true;
        long duration = player.getDuration();
        long position = Math.max(0, player.getCurrentPosition());
        if (duration <= 0 || duration == C.TIME_UNSET) return true;
        return position < duration - 30_000L && position < Math.round(duration * 0.97d);
    }

    private long recoverPositionMs() {
        if (player == null || isLiveContent()) return 0L;
        long duration = player.getDuration();
        long position = Math.max(0, player.getCurrentPosition());
        return duration > 0 ? Math.min(position, Math.max(0, duration - 1_000L)) : position;
    }

    private void recoverPlayback(final String reason) {
        if (player == null || freshStreamRequested) return;
        final int scheduledGeneration = ++recoveryGeneration;
        handler.removeCallbacks(bufferWatchdog);
        handler.removeCallbacks(healthyRecoveryReset);
        spinner.setVisibility(View.VISIBLE);
        errorView.setVisibility(View.GONE);

        // Startup failure: residential URL was never proven healthy, so use the
        // Gateway fallback immediately. Mid-stream: reconnect the already-good
        // direct Atlas route once before moving traffic to the datacenter.
        if (!everReady && !fallbackTried && fallbackUrl != null && !fallbackUrl.isEmpty()) {
            switchToFallback();
            return;
        }
        if (playRetries < 1) {
            playRetries++;
            final MediaItem current = player.getCurrentMediaItem();
            final long position = recoverPositionMs();
            handler.postDelayed(new Runnable() {
                @Override public void run() {
                    if (player == null || freshStreamRequested
                            || scheduledGeneration != recoveryGeneration) return;
                    MediaItem item = current != null ? current : MediaItem.fromUri(
                            fallbackTried && fallbackUrl != null ? fallbackUrl : originalUrl);
                    player.setMediaItem(item, position);
                    player.prepare();
                    applyPlaybackIntent();
                }
            }, 1_500L);
            return;
        }
        if (!fallbackTried && fallbackUrl != null && !fallbackUrl.isEmpty()) {
            switchToFallback();
            return;
        }
        if (isLiveContent()) {
            scheduleLiveReconnect(reason);
            return;
        }
        requestFreshStream(reason);
    }

    /**
     * Re-open the residential provider URL without leaving the native player.
     * Xtream live URLs are stable (credentials + stream id), so asking the
     * background WebView to mint another cloud bookkeeping session only creates
     * guide flashes and can exhaust its bounded recovery counter. Re-preparing
     * here is both faster and keeps the provider to one connection at a time.
     */
    private void scheduleLiveReconnect(final String reason) {
        if (player == null || originalUrl == null || originalUrl.isEmpty()) return;
        final int scheduledGeneration = ++recoveryGeneration;
        final int attempt = liveReconnectAttempts++;
        final long delay = LIVE_RECONNECT_DELAYS_MS[Math.min(
                attempt, LIVE_RECONNECT_DELAYS_MS.length - 1)];

        handler.removeCallbacks(bufferWatchdog);
        spinner.setVisibility(View.VISIBLE);
        errorView.setTextColor(Color.WHITE);
        errorView.setText(attempt < 2
                ? "Reconnecting to live TV…"
                : "The channel is taking longer to reconnect.\nNorva will keep trying automatically.");
        errorView.setVisibility(View.VISIBLE);
        reportPlaybackStatus("reconnecting", reason);

        handler.postDelayed(new Runnable() {
            @Override public void run() {
                if (player == null || freshStreamRequested
                        || scheduledGeneration != recoveryGeneration) return;
                // Always return to the residential URL after a fallback failure.
                // setMediaItem closes the previous DataSource before opening the
                // replacement, preserving single-slot provider accounts.
                fallbackTried = false;
                playRetries = 0;
                streamHost = hostOf(originalUrl);
                player.setMediaItem(MediaItem.fromUri(originalUrl));
                player.prepare();
                applyPlaybackIntent();
            }
        }, delay);
    }

    /**
     * Both the direct provider URL and its signed fallback were exhausted. Hand
     * the exact item + position back to the still-open WebView so it resolves a
     * fresh provider URL/session while this Activity remains visible.
     */
    private void requestFreshStream(String reason) {
        if (freshStreamRequested) return;
        recoveryGeneration++;
        if (sourceId == null || sourceId.isEmpty() || itemId == null || itemId.isEmpty()) {
            showActionableError(
                    getString(R.string.player_error_title),
                    getString(R.string.player_error_network));
            reportPlaybackStatus("broken", reason);
            return;
        }
        freshStreamRequested = true;
        freshStreamReason = reason == null ? "playback_interrupted" : reason;
        recoveryToken = UUID.randomUUID().toString();
        pendingRecoveryPositionMs = recoverPositionMs();
        long duration = player != null && player.getDuration() > 0
                ? player.getDuration() : 0L;
        errorView.setText(getString(R.string.player_reconnecting));
        errorView.setVisibility(View.VISIBLE);
        reportPlaybackStatus("reconnecting", reason);
        // Close the old provider socket before asking for a replacement; IPTV
        // accounts frequently allow only one active connection.
        if (player != null) player.stop();
        Intent request = new Intent(ACTION_REQUEST_FRESH_STREAM)
                .setPackage(getPackageName())
                .putExtra(EXTRA_RECOVERY_TOKEN, recoveryToken)
                .putExtra(EXTRA_SOURCE_ID, sourceId)
                .putExtra(EXTRA_ITEM_TYPE, itemType)
                .putExtra(EXTRA_ITEM_ID, itemId)
                .putExtra("positionSeconds", Math.max(0L, pendingRecoveryPositionMs / 1000L))
                .putExtra("durationSeconds", Math.max(0L, duration / 1000L))
                .putExtra("retryReason", freshStreamReason);
        sendBroadcast(request);
        handler.removeCallbacks(freshStreamTimeout);
        handler.postDelayed(freshStreamTimeout, 25_000L);
    }

    private void registerFreshStreamReceiver() {
        freshStreamReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (intent == null
                        || !ACTION_APPLY_FRESH_STREAM.equals(intent.getAction())) return;
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

    /**
     * Retire the exact in-flight recovery token. MainActivity must learn about
     * timeout/Back/destruction as well, otherwise its next same-item JSON launch
     * can be mistaken for the old response and silently swallowed.
     */
    private void clearFreshStreamRequest(boolean notifyHost) {
        String token = recoveryToken;
        handler.removeCallbacks(freshStreamTimeout);
        freshStreamRequested = false;
        recoveryToken = null;
        if (!notifyHost || token == null || token.isEmpty()) return;
        cancelledRecoveryTokenForResult = token;
        try {
            sendBroadcast(new Intent(ACTION_CANCEL_FRESH_STREAM)
                    .setPackage(getPackageName())
                    .putExtra(EXTRA_RECOVERY_TOKEN, token));
        } catch (RuntimeException ignored) {
            // finish() also returns the token as a second, lifecycle-safe ack.
        }
    }

    private void applyFreshStreamPayload(String payloadJson) {
        try {
            org.json.JSONObject payload = new org.json.JSONObject(payloadJson);
            String nextUrl = payload.optString("url", "");
            if (nextUrl.isEmpty() || player == null) {
                throw new IllegalArgumentException("missing url");
            }
            String nextSource = payload.optString("sourceId", "");
            String nextItem = payload.optString("itemId", "");
            if (!String.valueOf(sourceId).equals(nextSource)
                    || !String.valueOf(itemId).equals(nextItem)) {
                throw new SecurityException("item mismatch");
            }

            clearFreshStreamRequest(false);
            originalUrl = nextUrl;
            fallbackUrl = emptyToNull(payload.optString("fallbackUrl", ""));
            streamHost = hostOf(nextUrl);
            fallbackTried = false;
            playRetries = 0;
            everReady = false;
            trackPreferencesApplied = false;
            org.json.JSONObject metadata = payload.optJSONObject("trackMetadata");
            readTrackMetadata(metadata == null ? null : metadata.toString());
            org.json.JSONObject scope = payload.optJSONObject("preferenceScope");
            if (scope != null) preferenceScopeJson = scope.toString();
            org.json.JSONObject preferences = payload.optJSONObject("playbackPreferences");
            if (preferences != null) cloudPlaybackPreferencesJson = preferences.toString();
            // A recovery belongs to the same viewing session: local changes
            // made moments ago are newer than the launch payload. Cloud is
            // authoritative on a new launch, not mid-session.
            initializePlaybackPreferences(false);
            long payloadPosition = Math.max(
                    0L, payload.optLong("resumeSeconds", 0L) * 1000L);
            long requestedPosition = Math.max(pendingRecoveryPositionMs, payloadPosition);
            pendingRecoveryPositionMs = 0L;
            errorView.setVisibility(View.GONE);
            if (errorPanel != null) errorPanel.setVisibility(View.GONE);
            spinner.setVisibility(View.VISIBLE);
            player.setMediaItem(MediaItem.fromUri(nextUrl), requestedPosition);
            player.prepare();
            applyPlaybackIntent();
        } catch (Exception error) {
            android.util.Log.w(TAG, "fresh stream payload rejected", error);
            clearFreshStreamRequest(true);
            showActionableError(
                    getString(R.string.player_error_title),
                    getString(R.string.player_reconnect_failed));
        }
    }

    private static String emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }

    private void finishWithoutRecovery() {
        clearFreshStreamRequest(true);
        finish();
    }

    /** Reload from the gateway fallback URL after a direct-URL refusal (e.g. provider 401). */
    private void switchToFallback() {
        recoveryGeneration++;
        fallbackTried = true;
        playRetries = 0;
        trackPreferencesApplied = false;
        streamHost = hostOf(fallbackUrl);
        handler.removeCallbacks(bufferWatchdog);
        errorView.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        long position = recoverPositionMs();
        player.setMediaItem(MediaItem.fromUri(fallbackUrl), position);
        player.prepare();
        applyPlaybackIntent();
    }

    // ==================== Overlay ====================

    private void buildOverlay(String title) {
        overlay = new FrameLayout(this);
        overlay.setId(R.id.norva_tv_player_controls);
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        final int safe = Math.max(
                getResources().getDimensionPixelSize(R.dimen.norva_tv_player_safe_margin),
                Math.round(Math.min(
                        getResources().getDisplayMetrics().widthPixels,
                        getResources().getDisplayMetrics().heightPixels) * 0.05f));

        // Overscan-safe top bar. Back is a visible target, while the hardware
        // BACK key remains the fastest path out.
        LinearLayout top = new LinearLayout(this);
        top.setId(R.id.norva_tv_player_top_bar);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(safe, dp(18), safe, dp(12));
        top.setBackgroundColor(Color.parseColor("#66000000"));
        overlay.addView(top, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP));

        ImageButton back = makePlainIconButton(
                android.R.drawable.ic_menu_revert,
                getString(R.string.player_back_content_description),
                48, 12, Color.WHITE);
        back.setId(R.id.norva_tv_player_back_button);
        makeFocusable(back, 0);
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finishWithoutRecovery(); }
        });
        top.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

        titleView = new TextView(this);
        titleView.setId(R.id.norva_tv_player_title);
        titleView.setText(title == null ? "" : title);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(20);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams topTitleLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        topTitleLp.leftMargin = dp(12);
        top.addView(titleView, topTitleLp);

        clockView = new TextView(this);
        clockView.setId(R.id.norva_tv_player_clock);
        clockView.setTextColor(ACCENT);
        clockView.setTextSize(16);
        clockView.setPadding(dp(18), 0, 0, 0);
        updateClock();
        top.addView(clockView);

        // Bottom panel
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setBackgroundColor(PANEL);
        bottom.setPadding(safe, dp(14), safe, Math.max(dp(18), safe / 2));
        overlay.addView(bottom, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

        seekBar = new SeekBar(this);
        seekBar.setId(R.id.norva_tv_player_seek_bar);
        // Focusable: left/right scrub the timeline ONLY while it holds focus.
        // On the button rows, left/right move between buttons instead.
        seekBar.setFocusable(true);
        seekBar.setProgressTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        seekBar.setThumbTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        seekBar.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View v, boolean hasFocus) {
                // Grow the thumb/track a touch when focused so it's obvious the
                // timeline is the active control
                v.setScaleY(hasFocus ? 1.6f : 1f);
            }
        });
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser) timeView.setText(formatTime(progress * 1000L) + " / " + formatTime(player.getDuration()));
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { userSeeking = true; }
            @Override public void onStopTrackingTouch(SeekBar bar) {
                userSeeking = false;
                player.seekTo(bar.getProgress() * 1000L);
            }
        });
        bottom.addView(seekBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // Control row: time (left) | transport (center) | restart (right)
        FrameLayout controlRow = new FrameLayout(this);
        bottom.addView(controlRow, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        timeView = new TextView(this);
        timeView.setId(R.id.norva_tv_player_time);
        timeView.setTextColor(SUBTLE);
        timeView.setTextSize(15);
        FrameLayout.LayoutParams timeLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.START | Gravity.CENTER_VERTICAL);
        controlRow.addView(timeView, timeLp);

        LinearLayout transport = new LinearLayout(this);
        transport.setId(R.id.norva_tv_player_transport);
        transport.setOrientation(LinearLayout.HORIZONTAL);
        transport.setGravity(Gravity.CENTER_VERTICAL);
        controlRow.addView(transport, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL));

        ImageButton rewind = addCircleIcon(transport, R.drawable.ic_player_skip_back,
                getString(R.string.player_rewind_10), 48, false, new Runnable() {
            @Override public void run() { seekBy(-10000); }
        });
        rewind.setId(R.id.norva_tv_player_rewind_button);
        playPauseBtn = addCircleIcon(transport, R.drawable.ic_player_pause,
                getString(R.string.player_pause), 64, true, new Runnable() {
            @Override public void run() { togglePlay(); }
        });
        playPauseBtn.setId(R.id.norva_tv_player_play_pause_button);
        ImageButton forward = addCircleIcon(transport, R.drawable.ic_player_skip_forward,
                getString(R.string.player_forward_10), 48, false, new Runnable() {
            @Override public void run() { seekBy(10000); }
        });
        forward.setId(R.id.norva_tv_player_forward_button);

        // Mobile and TV now expose the same four high-frequency concepts in the
        // main row; the D-pad replaces mobile gestures without changing hierarchy.
        primaryActions = new LinearLayout(this);
        primaryActions.setId(R.id.norva_tv_player_primary_controls);
        primaryActions.setOrientation(LinearLayout.HORIZONTAL);
        primaryActions.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
        controlRow.addView(primaryActions, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.END | Gravity.CENTER_VERTICAL));

        audioButton = addDirectAction(
                R.id.norva_tv_player_audio_button,
                R.drawable.ic_player_audio,
                getString(R.string.player_audio_button),
                new Runnable() {
                    @Override public void run() {
                        showTrackDialog(C.TRACK_TYPE_AUDIO, getString(R.string.player_audio_track));
                    }
                });
        subtitleButton = addDirectAction(
                R.id.norva_tv_player_subtitle_button,
                R.drawable.ic_player_captions,
                getString(R.string.player_cc_button),
                new Runnable() {
                    @Override public void run() {
                        showTrackDialog(C.TRACK_TYPE_TEXT, getString(R.string.player_subtitles_button));
                    }
                });
        aspectButton = addDirectAction(
                R.id.norva_tv_player_aspect_button,
                R.drawable.ic_player_aspect_ratio,
                getString(R.string.player_aspect_button),
                new Runnable() {
                    @Override public void run() { cycleAspect(); }
                });
        moreButton = addDirectAction(
                R.id.norva_tv_player_more_button,
                R.drawable.ic_player_more,
                getString(R.string.player_more_options),
                new Runnable() {
                    @Override public void run() { toggleSecondBar(); }
                });
        chevron = moreButton;

        buildSecondBar(bottom);

        playPauseBtn.requestFocus();
        subtitleView.setBottomPaddingFraction(0.22f);
    }

    private void buildSecondBar(LinearLayout parent) {
        // Compact remote-only overflow. High-frequency Audio/CC/Fit live in the
        // main row; this panel contains only occasional management actions.
        HorizontalScrollView scroller = new HorizontalScrollView(this);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.setFillViewport(true);
        parent.addView(scroller, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        secondBar = new LinearLayout(this);
        secondBar.setId(R.id.norva_tv_player_options_panel);
        secondBar.setOrientation(LinearLayout.HORIZONTAL);
        secondBar.setGravity(Gravity.END);
        secondBar.setPadding(0, dp(6), 0, dp(6));
        secondBar.setVisibility(View.GONE);
        scroller.addView(secondBar, new HorizontalScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        videoValue = addBarItem(
                R.id.norva_tv_player_quality_button,
                R.drawable.ic_player_quality,
                getString(R.string.player_quality), "—", new Runnable() {
            @Override public void run() {
                showTrackDialog(C.TRACK_TYPE_VIDEO, getString(R.string.player_video_track));
            }
        });
        if (!isLiveContent()) {
            speedValue = addBarItem(
                    R.id.norva_tv_player_speed_button,
                    R.drawable.ic_player_speed,
                    getString(R.string.player_playback_speed_section), "1×", new Runnable() {
                @Override public void run() { cycleSpeed(); }
            });
        }
        sleepValue = addBarItem(
                R.id.norva_tv_player_sleep_button,
                R.drawable.ic_player_sleep,
                getString(R.string.player_sleep), getString(R.string.player_sleep_off), new Runnable() {
            @Override public void run() { cycleSleep(); }
        });
        // Live-only: switch the channel's quality variant (M6 HD/RAW/HEVC...). Present
        // only when the web handed us >1 variant.
        if (variants != null) {
            addBarItem(
                    R.id.norva_tv_player_variant_button,
                    R.drawable.ic_player_quality,
                    getString(R.string.player_version), currentVariantLabel(), new Runnable() {
                @Override public void run() { showVariantDialog(); }
            });
        }
        // Series-only shortcuts: jump to the next episode without waiting for the
        // end, and reopen the episode list (the fiche behind the player).
        if (nextTitle != null && !nextTitle.isEmpty()) {
            addBarItem(
                    R.id.norva_tv_player_next_episode_button,
                    R.drawable.ic_player_skip_forward,
                    getString(R.string.player_next_episode), "", new Runnable() {
                @Override public void run() { chooseNextEpisode(); }
            });
        }
        if ("episode".equals(itemType)) {
            addBarItem(
                    R.id.norva_tv_player_episodes_button,
                    R.drawable.ic_player_expand_less,
                    getString(R.string.player_episodes), getString(R.string.player_episode_list), new Runnable() {
                @Override public void run() { openEpisodesList(); }
            });
        }
    }

    /** One second-bar entry: icon on top, caption + live value below. */
    private TextView addBarItem(
            int id, int iconRes, String caption, String value, final Runnable action) {
        LinearLayout item = new LinearLayout(this);
        item.setId(id);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(18), dp(8), dp(18), dp(8));
        makeFocusable(item, 0);
        final String actionLabel = caption;
        item.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { runBarAction(actionLabel, action); }
        });

        ImageView icon = new ImageView(this);
        icon.setImageResource(iconRes);
        icon.setColorFilter(Color.WHITE);
        icon.setContentDescription(caption);
        item.addView(icon, new LinearLayout.LayoutParams(dp(24), dp(24)));

        TextView val = new TextView(this);
        val.setText(value);
        val.setTextColor(ACCENT);
        val.setTextSize(13);
        val.setGravity(Gravity.CENTER);
        val.setPadding(0, dp(3), 0, 0);
        item.addView(val);

        TextView cap = new TextView(this);
        cap.setText(caption);
        cap.setTextColor(SUBTLE);
        cap.setTextSize(11);
        cap.setGravity(Gravity.CENTER);
        item.addView(cap);

        secondBar.addView(item);
        return val;
    }

    private ImageButton addDirectAction(
            int id, int iconRes, String description, final Runnable action) {
        ImageButton button = makePlainIconButton(iconRes, description, 48, 11, Color.WHITE);
        button.setId(id);
        makeFocusable(button, 0);
        button.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                runBarAction(String.valueOf(v.getContentDescription()), action);
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(48), dp(48));
        lp.leftMargin = dp(6);
        primaryActions.addView(button, lp);
        return button;
    }

    // ==================== Circular transport buttons ====================

    private ImageButton addCircleIcon(LinearLayout parent, int iconRes, String description, int diameterDp,
                                      boolean primary, final Runnable action) {
        final ImageButton btn = makePlainIconButton(iconRes, description, diameterDp,
                primary ? 18 : 12, primary ? Color.parseColor("#0A0A0F") : Color.WHITE);
        final int idle = primary ? Color.parseColor("#E4E4F2") : Color.parseColor("#33FFFFFF");
        final int idleIcon = primary ? Color.parseColor("#0A0A0F") : Color.WHITE;

        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(idle);
        btn.setBackground(bg);

        // All transport buttons are focusable: left/right move between them
        // (the timeline scrub only happens when the seek bar itself is focused).
        btn.setFocusable(true);
        int d = dp(diameterDp);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(d, d);
        lp.leftMargin = dp(8);
        lp.rightMargin = dp(8);

        btn.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View v, boolean hasFocus) {
                GradientDrawable g = new GradientDrawable();
                g.setShape(GradientDrawable.OVAL);
                g.setColor(hasFocus ? ACCENT : idle);
                v.setBackground(g);
                ((ImageButton) v).setColorFilter(hasFocus ? Color.parseColor("#0A0A0F") : idleIcon);
                v.animate().scaleX(hasFocus ? 1.12f : 1f).scaleY(hasFocus ? 1.12f : 1f).setDuration(120).start();
            }
        });
        btn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { action.run(); scheduleHideControls(); }
        });
        parent.addView(btn, lp);
        return btn;
    }

    private ImageButton makePlainIconButton(int iconRes, String description, int sizeDp, int paddingDp, int color) {
        ImageButton btn = new ImageButton(this);
        btn.setImageResource(iconRes);
        btn.setColorFilter(color);
        btn.setContentDescription(description);
        btn.setScaleType(ImageView.ScaleType.CENTER);
        btn.setPadding(dp(paddingDp), dp(paddingDp), dp(paddingDp), dp(paddingDp));
        btn.setBackgroundColor(Color.TRANSPARENT);
        btn.setFocusable(true);
        btn.setMinimumWidth(dp(sizeDp));
        btn.setMinimumHeight(dp(sizeDp));
        return btn;
    }

    private void makeFocusable(final View v, int circleDp) {
        v.setFocusable(true);
        v.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View view, boolean hasFocus) {
                GradientDrawable g = new GradientDrawable();
                g.setColor(hasFocus ? Color.parseColor("#33818CF8") : Color.TRANSPARENT);
                g.setCornerRadius(dp(8));
                view.setBackground(g);
                view.animate().scaleX(hasFocus ? 1.08f : 1f).scaleY(hasFocus ? 1.08f : 1f).setDuration(120).start();
            }
        });
    }

    // ==================== Actions ====================

    /**
     * TV remotes activate these controls directly from focus. A broken stream
     * manifest, missing metadata or unsupported device dialog must never take
     * the native player down; keep playback alive and surface a short message.
     */
    private void runBarAction(String label, Runnable action) {
        try {
            if (action != null) action.run();
        } catch (Throwable t) {
            android.util.Log.e("PlayerActivity", "VOD player option failed: " + label, t);
            toast(label + " unavailable");
            scheduleHideControls();
        }
    }

    private void seekBy(long deltaMs) {
        long target = player.getCurrentPosition() + deltaMs;
        if (target < 0) target = 0;
        long dur = player.getDuration();
        if (dur > 0 && target > dur) target = dur;
        player.seekTo(target);
    }

    private void togglePlay() {
        if (player == null) return;
        userWantsPlayback = !player.getPlayWhenReady();
        applyPlaybackIntent();
        updatePlayPauseLabel();
        scheduleHideControls();
    }

    private boolean canPlayInCurrentLifecycle() {
        return activityForeground || isActuallyInPictureInPicture();
    }

    /**
     * The only path used by startup, fallback, watchdog and fresh-session
     * callbacks to change playWhenReady. They may prepare while backgrounded,
     * but playback resumes only in foreground/PiP and only if the viewer did
     * not explicitly pause.
     */
    private void applyPlaybackIntent() {
        if (player == null) return;
        boolean shouldPlay = userWantsPlayback && canPlayInCurrentLifecycle();
        if (player.getPlayWhenReady() == shouldPlay) return;
        applyingLifecyclePlaybackState = true;
        try {
            player.setPlayWhenReady(shouldPlay);
        } finally {
            applyingLifecyclePlaybackState = false;
        }
    }

    private void updatePlayPauseLabel() {
        if (playPauseBtn != null) {
            boolean playing = player != null && player.isPlaying();
            playPauseBtn.setImageResource(playing
                    ? R.drawable.ic_player_pause : R.drawable.ic_player_play);
            playPauseBtn.setContentDescription(getString(playing
                    ? R.string.player_pause : R.string.player_play));
        }
    }

    private void cycleAspect() {
        aspectMode = (aspectMode + 1) % 2;
        String selected = getString(aspectMode == 0
                ? R.string.player_resize_fit : R.string.player_resize_zoom);
        if (aspectValue != null) aspectValue.setText(selected);
        if (aspectButton != null) {
            aspectButton.setContentDescription(getString(
                    R.string.player_resize_selected_description, selected));
        }
        applyAspect();
        scheduleHideControls();
    }

    private void cycleSpeed() {
        speedIndex = (speedIndex + 1) % SPEEDS.length;
        float speed = SPEEDS[speedIndex];
        // Set both speed and pitch explicitly: setPlaybackSpeed() alone can be
        // a no-op on some builds, setPlaybackParameters always applies.
        player.setPlaybackParameters(new PlaybackParameters(speed, 1.0f));
        speedValue.setText(formatSpeed(speed));
        scheduleHideControls();
    }

    private String formatSpeed(float s) {
        if (s == (long) s) return String.format(Locale.US, "%d×", (long) s);
        return String.format(Locale.US, "%s×", String.valueOf(s));
    }

    private void cycleSleep() {
        sleepIndex = (sleepIndex + 1) % SLEEP_OPTIONS.length;
        sleepMinutes = SLEEP_OPTIONS[sleepIndex];
        handler.removeCallbacks(sleepRunnable);
        if (sleepMinutes > 0) {
            handler.postDelayed(sleepRunnable, sleepMinutes * 60_000L);
            sleepValue.setText(sleepMinutes + " min");
        } else {
            sleepValue.setText("Off");
        }
        scheduleHideControls();
    }

    private void applyAspect() {
        if (root == null || surfaceView == null) return;
        final int rootW = root.getWidth();
        final int rootH = root.getHeight();
        if (rootW == 0 || rootH == 0) {
            root.post(new Runnable() { @Override public void run() { applyAspect(); } });
            return;
        }
        if (videoW <= 0 || videoH <= 0) {
            return;
        }
        double videoAspect = (double) videoW / videoH;
        double rootAspect = (double) rootW / rootH;
        int w, h;
        if (aspectMode == 1) {            // zoom / crop
            if (videoAspect > rootAspect) { h = rootH; w = (int) (rootH * videoAspect); }
            else { w = rootW; h = (int) (rootW / videoAspect); }
        } else {                          // fit (letterbox)
            if (videoAspect > rootAspect) { w = rootW; h = (int) (rootW / videoAspect); }
            else { h = rootH; w = (int) (rootH * videoAspect); }
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, h, Gravity.CENTER);
        surfaceView.setScaleX(1f);
        surfaceView.setScaleY(1f);
        surfaceView.setTranslationX(0f);
        surfaceView.setTranslationY(0f);
        surfaceView.setLayoutParams(lp);
        surfaceView.requestLayout();
    }

    private void openEpisodesList() {
        if (!"episode".equals(itemType) || itemId == null || itemId.isEmpty()
                || sourceId == null || sourceId.isEmpty()) {
            toast("Episode list unavailable");
            scheduleHideControls();
            return;
        }
        openEpisodesChosen = true;
        finish();
    }

    // ==================== Track selection ====================

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

        TrackOption(
                int type, TrackGroup group, int trackIndex, String label,
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

    /**
     * Accept only exact-file facts. Group/title aggregates are deliberately
     * ignored: they can describe a sibling provider version rather than the
     * bytes currently open in ExoPlayer.
     */
    private void readTrackMetadata(String json) {
        verifiedAudioTracks = null;
        exactSubtitleTracks = null;
        if (json == null || json.trim().isEmpty()) return;
        try {
            org.json.JSONObject metadata = new org.json.JSONObject(json);
            String status = metadata.optString(
                    "audioValidationStatus", "").toLowerCase(Locale.ROOT);
            if ("file".equals(metadata.optString("audioTracksScope", ""))
                    && isAcceptedAudioEvidence(status)) {
                verifiedAudioTracks = metadata.optJSONArray("audioTracks");
            }
            if ("file".equals(metadata.optString("subtitleTracksScope", ""))) {
                exactSubtitleTracks = metadata.optJSONArray("subtitleTracks");
            }
        } catch (Exception ignored) {
            verifiedAudioTracks = null;
            exactSubtitleTracks = null;
        }
    }

    private static boolean isAcceptedAudioEvidence(String status) {
        return "verified".equals(status)
                || "verified_union".equals(status)
                || "probed".equals(status)
                || "probed_union".equals(status);
    }

    private void initializePlaybackPreferences(boolean cloudAuthoritative) {
        PlaybackPreferenceStore.Preferences sessionPreferences =
                resolvedTrackPreferences;
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
                .versionKey(rawScope == null ? itemId
                        : rawScope.optString("versionKey", itemId))
                .itemType(itemType)
                .itemId(itemId)
                .seriesId(rawScope == null ? "" : rawScope.optString("seriesId", ""))
                .build();

        PlaybackPreferenceStore.Preferences cloud =
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
        if (cloudAuthoritative && cloud != null && !cloud.isEmpty()) {
            persistAuthoritativeCloudPreferences(cloud);
        }
        if (!cloudAuthoritative && sessionPreferences != null
                && !sessionPreferences.isEmpty()) {
            resolvedTrackPreferences = sessionPreferences;
            return;
        }
        resolvedTrackPreferences = preferenceStore.resolve(
                preferenceScope,
                cloudAuthoritative ? cloud : PlaybackPreferenceStore.Preferences.empty());
    }

    /**
     * A launch payload was resolved from the account/profile cloud state, so it
     * must be able to replace a stale TV-local choice. Persist field-by-field:
     * absent cloud fields retain their local fallback, present fields win at
     * exact, series and profile scope.
     */
    private void persistAuthoritativeCloudPreferences(
            PlaybackPreferenceStore.Preferences cloud) {
        if (preferenceStore == null || preferenceScope == null || cloud == null) return;
        TrackSelectionResolver.Preference audio = cloud.getAudio();
        if (audio != null) {
            TrackSelectionResolver.Preference portable = portablePreference(audio);
            preferenceStore.saveExactAudio(preferenceScope, audio);
            preferenceStore.saveSeriesAudio(preferenceScope, portable);
            preferenceStore.saveProfileAudio(preferenceScope, portable);
        }
        TrackSelectionResolver.Preference subtitle = cloud.getSubtitle();
        if (subtitle != null) {
            TrackSelectionResolver.Preference portable = portablePreference(subtitle);
            preferenceStore.saveExactSubtitle(preferenceScope, subtitle);
            preferenceStore.saveSeriesSubtitle(preferenceScope, portable);
            preferenceStore.saveProfileSubtitle(preferenceScope, portable);
        }
    }

    private static TrackSelectionResolver.Preference portablePreference(
            TrackSelectionResolver.Preference preference) {
        if (preference == null || preference.isDisabled()) {
            return TrackSelectionResolver.Preference.off();
        }
        return TrackSelectionResolver.Preference.selected(
                "", preference.getLanguage(), preference.getRole());
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
                raw.optString("stableId", ""), raw.optString("stable_id", ""));
        if (stableId == null) {
            int streamIndex = raw.has("streamIndex")
                    ? raw.optInt("streamIndex", -1)
                    : raw.optInt("stream_index", -1);
            if (streamIndex >= 0) stableId = "stream:" + streamIndex;
        }
        String language = firstNonEmpty(
                raw.optString("language", ""), raw.optString("lang", ""));
        TrackSelectionResolver.Role role =
                TrackSelectionResolver.Role.from(raw.optString("role", ""));
        if ((stableId == null || stableId.isEmpty())
                && (language == null || language.isEmpty())
                && role == TrackSelectionResolver.Role.UNKNOWN) return null;
        return TrackSelectionResolver.Preference.selected(stableId, language, role);
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

    private static List<TrackSelectionResolver.Track> resolverTracks(
            List<TrackOption> options) {
        List<TrackSelectionResolver.Track> result = new ArrayList<>();
        for (int i = 0; i < options.size(); i++) {
            TrackOption option = options.get(i);
            result.add(new TrackSelectionResolver.Track(
                    i, option.stableId, option.language, option.role,
                    option.supported, option.selected, option.defaultTrack));
        }
        return result;
    }

    private void confirmPendingTrackSelection(Tracks tracks) {
        if (pendingSubtitleOff) {
            List<TrackOption> subtitles = collectTrackOptions(tracks, C.TRACK_TYPE_TEXT);
            if (!hasSelectedTrack(subtitles)) {
                saveTrackPreference(C.TRACK_TYPE_TEXT, TrackSelectionResolver.Preference.off());
            }
            pendingSubtitleOff = false;
        }
        if (pendingTrackSelection != null) {
            TrackOption requested = pendingTrackSelection;
            for (TrackOption option : collectTrackOptions(tracks, requested.type)) {
                if (option.selected && option.stableId.equals(requested.stableId)) {
                    saveTrackPreference(requested.type,
                            TrackSelectionResolver.Preference.selected(
                                    option.stableId, option.language, option.role));
                    break;
                }
            }
            pendingTrackSelection = null;
        }
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
            audioPreferenceDirty = true;
        } else if (type == C.TRACK_TYPE_TEXT) {
            preferenceStore.saveExactSubtitle(preferenceScope, exactPreference);
            preferenceStore.saveSeriesSubtitle(preferenceScope, portable);
            preferenceStore.saveProfileSubtitle(preferenceScope, portable);
            resolvedTrackPreferences = resolvedTrackPreferences.withSubtitle(exactPreference);
            subtitlePreferenceDirty = true;
        }
    }

    /** Export only explicit viewer changes, never Media3's automatic defaults. */
    private String dirtyTrackPreferencesJson() {
        if (!audioPreferenceDirty && !subtitlePreferenceDirty) return null;
        return preferencesToJson(new PlaybackPreferenceStore.Preferences(
                audioPreferenceDirty ? resolvedTrackPreferences.getAudio() : null,
                subtitlePreferenceDirty ? resolvedTrackPreferences.getSubtitle() : null));
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
            value.put("disabled", true).put("source", "off").put("mode", "off");
            return value;
        }
        if (!preference.getStableId().isEmpty()) value.put("stableId", preference.getStableId());
        if (!preference.getLanguage().isEmpty()) value.put("language", preference.getLanguage());
        if (preference.getRole() != TrackSelectionResolver.Role.UNKNOWN) {
            value.put("role", preference.getRole().name().toLowerCase(Locale.ROOT));
        }
        return value.length() == 0 ? null : value;
    }

    private TrackMeta trackMetaAt(
            org.json.JSONArray tracks, Format format, int ordinal) {
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
        return ordinal >= 0 && ordinal < tracks.length()
                ? parseTrackMeta(tracks.optJSONObject(ordinal)) : null;
    }

    private static TrackMeta parseTrackMeta(org.json.JSONObject raw) {
        if (raw == null) return null;
        TrackMeta meta = new TrackMeta();
        meta.streamIndex = raw.optInt("index", -1);
        meta.stableId = raw.optString("id", "");
        meta.language = firstNonEmpty(
                raw.optString("lang", ""), raw.optString("language", ""),
                raw.optString("iso_639_1", ""), raw.optString("iso639", ""),
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
            java.util.regex.Matcher matcher =
                    java.util.regex.Pattern.compile("(\\d+)$").matcher(id);
            return matcher.find() ? Integer.parseInt(matcher.group(1)) : -1;
        } catch (Exception ignored) {
            return -1;
        }
    }

    private static String safeLanguageName(String raw) {
        if (raw == null) return null;
        String normalized = TrackSelectionResolver.normalizeLanguage(raw);
        if (normalized.isEmpty()) return null;
        String code = normalized;
        int dash = code.indexOf('-');
        if (dash > 0) code = code.substring(0, dash);
        if (!code.matches("[a-z]{2,3}")) return null;
        try {
            Locale language = new Locale(code);
            String display = language.getDisplayLanguage(Locale.getDefault());
            if (display == null || display.trim().isEmpty()
                    || display.equalsIgnoreCase(code)) return null;
            return display.substring(0, 1).toUpperCase(Locale.getDefault())
                    + display.substring(1);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String safeCodec(String raw) {
        if (raw == null) return null;
        String codec = raw.trim().toUpperCase(Locale.ROOT);
        if (codec.startsWith("AUDIO/")) codec = codec.substring(6);
        if (codec.isEmpty() || codec.length() > 16
                || !codec.matches("[A-Z0-9._+-]+")) return null;
        if ("EAC3".equals(codec)) return "E-AC-3";
        if ("AC3".equals(codec)) return "AC-3";
        return codec;
    }

    private String safeTrackLabel(
            int type, Format format, TrackMeta metadata, int position) {
        if (type == C.TRACK_TYPE_VIDEO) {
            if (format != null && format.width > 0 && format.height > 0) {
                return format.width + "×" + format.height;
            }
            return getString(R.string.player_video_track) + " " + position;
        }
        String language = metadata == null ? null : safeLanguageName(metadata.language);
        // Provider audio tags are not trusted without exact-file evidence.
        // Subtitle tags are track-scoped and safe as a fallback.
        if (language == null && type == C.TRACK_TYPE_TEXT && format != null) {
            language = safeLanguageName(format.language);
        }
        String label = language != null ? language : getString(
                type == C.TRACK_TYPE_AUDIO
                        ? R.string.player_audio_unknown
                        : R.string.player_subtitle_unknown,
                position);
        List<String> details = new ArrayList<>();
        String codec = safeCodec(metadata != null ? metadata.codec
                : (format == null ? null : format.sampleMimeType));
        if (codec != null) details.add(codec);
        int channels = metadata != null && metadata.channels > 0
                ? metadata.channels : (format == null ? -1 : format.channelCount);
        if (type == C.TRACK_TYPE_AUDIO && channels > 0) {
            if (channels == 1) details.add("mono");
            else if (channels == 2) details.add("stereo");
            else if (channels == 6) details.add("5.1");
            else if (channels == 8) details.add("7.1");
        }
        if (type == C.TRACK_TYPE_TEXT && metadata != null) {
            if (metadata.forced) details.add("Forced");
            if (metadata.sdh) details.add("SDH");
        }
        return details.isEmpty()
                ? label : label + " · " + android.text.TextUtils.join(" · ", details);
    }

    private List<TrackOption> collectTrackOptions(Tracks tracks, int type) {
        List<TrackOption> result = new ArrayList<>();
        if (tracks == null) return result;
        int ordinal = 0;
        org.json.JSONArray metadata = type == C.TRACK_TYPE_AUDIO
                ? verifiedAudioTracks : (type == C.TRACK_TYPE_TEXT
                    ? exactSubtitleTracks : null);
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
                                    type == C.TRACK_TYPE_AUDIO ? "audio"
                                            : (type == C.TRACK_TYPE_TEXT ? "subtitle" : "video"),
                                    language, role,
                                    exact != null ? exact.codec : format.sampleMimeType,
                                    exact != null && exact.channels > 0
                                            ? exact.channels : format.channelCount)));
                boolean defaultTrack = exact != null && exact.defaultTrack
                        || (format.selectionFlags & C.SELECTION_FLAG_DEFAULT) != 0;
                result.add(new TrackOption(
                        type, group.getMediaTrackGroup(), i,
                        safeTrackLabel(type, format, exact, ordinal + 1),
                        stableId, language, role,
                        group.isTrackSelected(i), group.isTrackSupported(i), defaultTrack));
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
        if (format == null) {
            return type == C.TRACK_TYPE_TEXT
                    ? TrackSelectionResolver.Role.FULL : TrackSelectionResolver.Role.MAIN;
        }
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
                ? TrackSelectionResolver.Role.FULL : TrackSelectionResolver.Role.MAIN;
    }

    private static boolean hasSelectedTrack(List<TrackOption> options) {
        for (TrackOption option : options) if (option.selected) return true;
        return false;
    }

    private void showTrackDialog(final int trackType, String title) {
        Tracks tracks = player.getCurrentTracks();
        final List<TrackOption> options = new ArrayList<>();
        for (TrackOption option : collectTrackOptions(tracks, trackType)) {
            if (option.supported) options.add(option);
        }
        final List<String> labels = new ArrayList<>();

        final boolean isText = trackType == C.TRACK_TYPE_TEXT;
        if (isText) labels.add(getString(R.string.player_subtitles_off));

        int selected = isText ? 0 : -1;
        for (TrackOption option : options) {
            labels.add(option.label);
            if (option.selected) selected = labels.size() - 1;
        }

        if (labels.size() <= (isText ? 1 : 0)) {
            toast(getString(isText
                    ? R.string.player_subtitles_unavailable
                    : R.string.player_audio_unavailable));
            return;
        }

        new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle(title)
                .setSingleChoiceItems(labels.toArray(new String[0]), selected,
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                if (isText && which == 0) {
                                    pendingTrackSelection = null;
                                    pendingSubtitleOff = true;
                                    player.setTrackSelectionParameters(
                                            player.getTrackSelectionParameters().buildUpon()
                                                    .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                                                    .setTrackTypeDisabled(
                                                            C.TRACK_TYPE_TEXT, true)
                                                    .build());
                                } else {
                                    int optionIndex = which - (isText ? 1 : 0);
                                    TrackOption option = options.get(optionIndex);
                                    pendingTrackSelection = option;
                                    pendingSubtitleOff = false;
                                    player.setTrackSelectionParameters(
                                            player.getTrackSelectionParameters().buildUpon()
                                                    .setTrackTypeDisabled(trackType, false)
                                                    .clearOverridesOfType(trackType)
                                                    .setOverrideForType(
                                                            new TrackSelectionOverride(
                                                                    option.group,
                                                                    option.trackIndex))
                                                    .build());
                                }
                                dialog.dismiss();
                                refreshSecondBarValues();
                                scheduleHideControls();
                            }
                        })
                .show();
    }

    /** Label of the currently-playing variant (for the bar item's value line). */
    private String currentVariantLabel() {
        if (variants == null) return "—";
        try {
            for (int i = 0; i < variants.length(); i++) {
                org.json.JSONObject v = variants.optJSONObject(i);
                if (v != null && activeStreamId != null
                        && activeStreamId.equals(v.optString("streamId"))) {
                    return v.optString("label", "—");
                }
            }
        } catch (Exception ignored) { }
        return "—";
    }

    /**
     * Pick a quality variant. We can't swap the source in place (a live gateway grants
     * one slot), so record the choice and finish() — MainActivity forwards it to the web,
     * which re-resolves + relaunches that variant.
     */
    private void showVariantDialog() {
        if (variants == null) return;
        final List<String> labels = new ArrayList<>();
        final List<String> streamIds = new ArrayList<>();
        final List<String> sourceIds = new ArrayList<>();
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
        if (labels.size() < 2) { toast("No other version"); return; }

        new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Version")
                .setSingleChoiceItems(labels.toArray(new String[0]), selected,
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                dialog.dismiss();
                                if (streamIds.get(which).equals(activeStreamId)) return; // already playing
                                pendingVariantStreamId = streamIds.get(which);
                                pendingVariantSourceId = sourceIds.get(which);
                                finish(); // MainActivity → web re-resolves + relaunches this variant
                            }
                        })
                .show();
    }

    private void applyTrack(int trackType, Tracks.Group group, int trackIndex) {
        if (group == null) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(trackType, true).build());
            subtitleView.setVisibility(View.GONE);
            if (trackType == C.TRACK_TYPE_TEXT) saveSubPref(SUB_OFF);
            return;
        }
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(trackType, false)
                .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), trackIndex))
                .build());
        if (trackType == C.TRACK_TYPE_TEXT) {
            Format f = group.getTrackFormat(trackIndex);
            saveSubPref(f.language != null && !"und".equals(f.language) ? f.language : SUB_ON);
        }
    }

    private String describeTrack(Format f, int trackType, int ordinal) {
        StringBuilder s = new StringBuilder();
        if (trackType == C.TRACK_TYPE_VIDEO) {
            if (f.width > 0 && f.height > 0) s.append(f.width).append("×").append(f.height);
            else s.append("Vidéo ").append(ordinal);
            if (f.frameRate > 0) s.append(" · ").append(Math.round(f.frameRate)).append("fps");
            return s.toString();
        }
        if (f.label != null && !f.label.isEmpty()) s.append(f.label);
        else if (f.language != null && !"und".equals(f.language))
            s.append(new Locale(f.language).getDisplayLanguage(Locale.getDefault()));
        else s.append(trackType == C.TRACK_TYPE_AUDIO ? "Audio " : "Subtitle ").append(ordinal);
        if (f.language != null && !"und".equals(f.language)) s.append(" [").append(f.language).append("]");
        if (trackType == C.TRACK_TYPE_AUDIO) {
            if (f.channelCount == 6) s.append(" · 5.1");
            else if (f.channelCount == 8) s.append(" · 7.1");
            else if (f.channelCount == 2) s.append(" · stereo");
            if (f.codecs != null) s.append(" · ").append(f.codecs);
        }
        return s.toString();
    }

    // ---- Subtitle preference (remember the viewer's choice per title) ----
    // Keyed by title and matched by language (track order can change between
    // plays), with an explicit Off sentinel. Mirrors the web player so the
    // chosen subtitle survives reopening instead of resetting to the default.

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

    /**
     * Re-apply the saved subtitle choice for this title once the tracks are
     * known. A saved language absent from this stream leaves ExoPlayer's default
     * untouched; runs only once per playback (a manual pick takes precedence).
     */
    private void maybeRestoreSubtitlePref() {
        if (subPrefRestored || subKey == null || player == null) return;
        String pref = loadSubPref();
        if (pref == null) return;
        subPrefRestored = true;
        if (SUB_OFF.equals(pref)) {
            applyTrack(C.TRACK_TYPE_TEXT, null, -1);
            refreshSecondBarValues();
            return;
        }
        Tracks.Group firstText = null;
        int firstIndex = -1;
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSupported(i)) continue;
                if (firstText == null) { firstText = g; firstIndex = i; }
                Format f = g.getTrackFormat(i);
                if (f.language != null && f.language.equals(pref)) {
                    applyTrack(C.TRACK_TYPE_TEXT, g, i);
                    refreshSecondBarValues();
                    return;
                }
            }
        }
        if (SUB_ON.equals(pref) && firstText != null) {
            applyTrack(C.TRACK_TYPE_TEXT, firstText, firstIndex);
            refreshSecondBarValues();
        }
    }

    /** Refresh the value labels shown under each second-bar icon. */
    private void refreshSecondBarValues() {
        if (player == null) return;
        Tracks tracks = player.getCurrentTracks();
        String video = videoW > 0 ? videoW + "×" + videoH : "—";
        String audio = getString(R.string.player_audio_track);
        String sub = getString(R.string.player_subtitles_off);
        for (TrackOption option : collectTrackOptions(tracks, C.TRACK_TYPE_AUDIO)) {
            if (option.selected) {
                audio = option.label;
                break;
            }
        }
        for (TrackOption option : collectTrackOptions(tracks, C.TRACK_TYPE_TEXT)) {
            if (option.selected) {
                sub = option.label;
                break;
            }
        }
        if (videoValue != null) videoValue.setText(video);
        if (audioValue != null) audioValue.setText(audio);
        if (subValue != null) subValue.setText(sub);
        if (audioButton != null) {
            audioButton.setContentDescription(getString(
                    R.string.player_audio_selected_description, audio));
        }
        if (subtitleButton != null) {
            subtitleButton.setContentDescription(getString(
                    R.string.player_subtitles_selected_description, sub));
        }
    }

    private String shortAudio(Format f) {
        String lang = (f.language != null && !"und".equals(f.language)) ? f.language.toUpperCase(Locale.US) : "";
        String ch = f.channelCount == 6 ? "5.1" : (f.channelCount == 8 ? "7.1" : (f.channelCount == 2 ? "2.0" : ""));
        String r = (lang + " " + ch).trim();
        return r.isEmpty() ? "Audio" : r;
    }

    private String shortLang(Format f) {
        if (f.language != null && !"und".equals(f.language)) return f.language.toUpperCase(Locale.US);
        if (f.label != null && !f.label.isEmpty()) return f.label;
        return "On";
    }

    // ==================== OSD show/hide ====================

    private void toggleSecondBar() {
        if (secondBarVisible) closeSecondBar(); else openSecondBar();
    }

    private void openSecondBar() {
        if (!secondBarVisible) {
            secondBarVisible = true;
            secondBar.setVisibility(View.VISIBLE);
            refreshSecondBarValues();
        }
        if (secondBar.getChildCount() > 0) secondBar.getChildAt(0).requestFocus();
        scheduleHideControls();
    }

    private void closeSecondBar() {
        secondBarVisible = false;
        secondBar.setVisibility(View.GONE);
        playPauseBtn.requestFocus();
        scheduleHideControls();
    }

    private void showControls() {
        showControls(playPauseBtn);
    }

    /** Reveal the OSD and park focus on the given control (when freshly shown). */
    private void showControls(View focusTarget) {
        boolean wasHidden = !controlsVisible;
        overlay.setVisibility(View.VISIBLE);
        controlsVisible = true;
        if (subtitleView != null) subtitleView.setBottomPaddingFraction(0.22f);
        if (wasHidden && !secondBarVisible && focusTarget != null) {
            focusTarget.requestFocus();
        }
        scheduleHideControls();
    }

    private void focusTransport() {
        if (secondBarVisible) closeSecondBar(); // also focuses play/pause
        else playPauseBtn.requestFocus();
        scheduleHideControls();
    }

    private void hideControls() {
        if (player != null && !player.isPlaying()) return; // stay visible while paused
        overlay.setVisibility(View.GONE);
        controlsVisible = false;
        secondBarVisible = false;
        secondBar.setVisibility(View.GONE);
        if (subtitleView != null) subtitleView.setBottomPaddingFraction(0.08f);
    }

    private void scheduleHideControls() {
        handler.removeCallbacks(hideControlsRunnable);
        handler.postDelayed(hideControlsRunnable, 5000);
    }

    private long seekStepForRepeat(int repeat) {
        if (repeat < 3) return 10000;
        if (repeat < 9) return 30000;
        return 60000;
    }

    /**
     * Adjust the pending scrub target and reflect it live on the bar/time.
     * The real seek is committed shortly after the last key press.
     */
    private void scrubBy(long delta) {
        if (player == null) return;
        long dur = player.getDuration();
        long base = pendingSeekTarget >= 0 ? pendingSeekTarget : player.getCurrentPosition();
        long target = base + delta;
        if (target < 0) target = 0;
        if (dur > 0 && target > dur) target = dur;
        pendingSeekTarget = target;

        if (dur > 0) {
            seekBar.setMax((int) (dur / 1000));
            seekBar.setProgress((int) (target / 1000));
            timeView.setText(formatTime(target) + " / " + formatTime(dur));
        } else {
            timeView.setText(formatTime(target));
        }
        handler.removeCallbacks(commitSeekRunnable);
        handler.postDelayed(commitSeekRunnable, 450);
    }

    private void commitPendingSeek() {
        if (player != null && pendingSeekTarget >= 0) {
            player.seekTo(pendingSeekTarget);
        }
        pendingSeekTarget = -1;
    }

    private void updateProgress() {
        if (player == null || userSeeking) return;
        if (pendingSeekTarget >= 0) return; // holding a scrub preview
        long pos = player.getCurrentPosition();
        long dur = player.getDuration();
        if (dur > 0) {
            seekBar.setMax((int) (dur / 1000));
            seekBar.setProgress((int) (pos / 1000));
            timeView.setText(formatTime(pos) + " / " + formatTime(dur));
        } else {
            timeView.setText(formatTime(pos));
        }
    }

    private void updateClock() {
        if (clockView != null) clockView.setText(clockFmt.format(new Date()));
    }

    private String formatTime(long ms) {
        if (ms < 0) ms = 0;
        long t = ms / 1000;
        long h = t / 3600, m = (t % 3600) / 60, s = t % 60;
        if (h > 0) return String.format(Locale.US, "%d:%02d:%02d", h, m, s);
        return String.format(Locale.US, "%d:%02d", m, s);
    }

    private void toast(String msg) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_DOWN) {
            return super.dispatchKeyEvent(event);
        }
        int code = event.getKeyCode();
        int repeat = event.getRepeatCount();

        // Never absorb system volume/mute keys: they belong to the TV/receiver,
        // including while the OSD is hidden.
        if (code == KeyEvent.KEYCODE_VOLUME_UP
                || code == KeyEvent.KEYCODE_VOLUME_DOWN
                || code == KeyEvent.KEYCODE_VOLUME_MUTE
                || code == KeyEvent.KEYCODE_MUTE) {
            return super.dispatchKeyEvent(event);
        }

        if (errorPanel != null && errorPanel.getVisibility() == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_BACK) {
                finishWithoutRecovery();
                return true;
            }
            return super.dispatchKeyEvent(event);
        }

        // "À suivre" overlay open: BACK closes the player, everything else uses
        // the native focus traversal between the two buttons.
        if (nextPanel != null) {
            if (code == KeyEvent.KEYCODE_BACK) { cancelNextPanel(); return true; }
            return super.dispatchKeyEvent(event);
        }

        if (code == KeyEvent.KEYCODE_BACK) {
            // One intermediate level only: an open options bar swallows the first
            // BACK. Otherwise BACK leaves immediately — even with the OSD showing,
            // which auto-hides on its own timer anyway (no more double/triple BACK).
            if (secondBarVisible) { closeSecondBar(); return true; }
            finishWithoutRecovery();
            return true;
        }
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            togglePlay(); showControls(); return true;
        }
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY || code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            userWantsPlayback = code == KeyEvent.KEYCODE_MEDIA_PLAY;
            applyPlaybackIntent();
            updatePlayPauseLabel();
            showControls();
            return true;
        }
        // Dedicated media transport keys always scrub the timeline
        if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) {
            showControls(seekBar); seekBar.requestFocus(); scrubBy(seekStepForRepeat(repeat)); return true;
        }
        if (code == KeyEvent.KEYCODE_MEDIA_REWIND) {
            showControls(seekBar); seekBar.requestFocus(); scrubBy(-seekStepForRepeat(repeat)); return true;
        }

        // --- OSD hidden: reveal it. Left/Right also start scrubbing (you're
        // "just watching", so seeking is the natural action). ---
        if (!controlsVisible) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                    showControls(seekBar); seekBar.requestFocus(); scrubBy(-seekStepForRepeat(repeat)); return true;
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    showControls(seekBar); seekBar.requestFocus(); scrubBy(seekStepForRepeat(repeat)); return true;
                case KeyEvent.KEYCODE_DPAD_UP:
                    showControls(seekBar); return true;       // reveal, land on timeline
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    showControls(playPauseBtn); openSecondBar(); return true; // reveal + management bar
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                    showControls(playPauseBtn); return true;                  // first OK reveals only
                default:
                    return super.dispatchKeyEvent(event);
            }
        }

        // --- OSD visible: route by which zone currently holds focus ---
        final boolean onTimeline = seekBar.hasFocus();
        final boolean onOptions = secondBarVisible && secondBar.hasFocus();

        if (onTimeline) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_LEFT:  scrubBy(-seekStepForRepeat(repeat)); return true;
                case KeyEvent.KEYCODE_DPAD_RIGHT: scrubBy(seekStepForRepeat(repeat)); return true;
                case KeyEvent.KEYCODE_DPAD_DOWN:  focusTransport(); return true;   // timeline → transport
                case KeyEvent.KEYCODE_DPAD_UP:    scheduleHideControls(); return true; // nothing above
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:      togglePlay(); return true;
            }
            scheduleHideControls();
            return true;
        }

        if (onOptions) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_UP:    focusTransport(); return true;    // options → transport
                case KeyEvent.KEYCODE_DPAD_DOWN:  scheduleHideControls(); return true; // nothing below
                default:
                    // Left/Right move between options, Center activates: native
                    scheduleHideControls();
                    return super.dispatchKeyEvent(event);
            }
        }

        // --- Transport zone (buttons row) ---
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:
                seekBar.requestFocus(); scheduleHideControls(); return true;       // transport → timeline
            case KeyEvent.KEYCODE_DPAD_DOWN:
                openSecondBar(); return true;                                      // transport → management bar
            default:
                // Left/Right move between transport buttons, Center clicks: native
                scheduleHideControls();
                return super.dispatchKeyEvent(event);
        }
    }

    private void hideOverlayNow() {
        overlay.setVisibility(View.GONE);
        controlsVisible = false;
        secondBarVisible = false;
        secondBar.setVisibility(View.GONE);
        if (subtitleView != null) subtitleView.setBottomPaddingFraction(0.08f);
    }

    // ==================== Picture-in-Picture ====================
    // HOME while playing shrinks into a PiP window instead of killing playback
    // (Android TV supports it since O; launchers without it just background us).

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (android.os.Build.VERSION.SDK_INT < 26) return;
        if (player == null || !player.isPlaying() || nextPanel != null) return;
        try {
            android.util.Rational ratio = new android.util.Rational(16, 9);
            if (videoW > 0 && videoH > 0) {
                float r = (float) videoW / videoH;
                if (r >= 0.42f && r <= 2.39f) ratio = new android.util.Rational(videoW, videoH);
            }
            enterPictureInPictureMode(new android.app.PictureInPictureParams.Builder()
                    .setAspectRatio(ratio).build());
        } catch (Exception ignored) { /* PiP unsupported on this device */ }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, android.content.res.Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPip, newConfig);
        if (isInPip) hideOverlayNow();
        else showControls();
        applyPlaybackIntent();
    }

    /**
     * Persist the live position to SharedPreferences so a non-graceful exit
     * (standby, power-off, OOM, crash) doesn't lose the session. Throttled to
     * ~10s unless forced (onPause/onStop). Best-effort — never throws into the
     * player. Skipped once finish() has emitted an authoritative result.
     */
    private void maybePersistProgress(boolean force) {
        try {
            if (gracefulResultEmitted) return;
            if (player == null || itemId == null || itemId.isEmpty()) return;
            long now = android.os.SystemClock.elapsedRealtime();
            if (!force && now - lastProgressPersistMs < 10000L) return;
            long pos = Math.max(0, player.getCurrentPosition() / 1000);
            if (pos <= 0) return;
            long dur = player.getDuration() > 0 ? player.getDuration() / 1000 : 0;
            lastProgressPersistMs = now;
            writePendingProgress(pos, dur);
            // Cloud heartbeat relay (~45s): while the native player is on top, MainActivity's
            // WebView is idle — relay the live position into it so other devices see this TV
            // advance DURING the film, not hours later at close (sync audit 2026-07-17 P1 n°4).
            // VOD only: a live channel would write a junk history row per tick.
            if (!"channel".equals(itemType) && now - lastCloudRelayMs >= 45000L) {
                lastCloudRelayMs = now;
                MainActivity main = MainActivity.currentInstance();
                if (main != null) main.relayNativeHeartbeat(sourceId, itemType, itemId, pos, dur);
            }
        } catch (Exception ignored) { /* progress persistence is best-effort */ }
    }

    /**
     * The SharedPreferences safety net. savedAt doubles as the delivery token: the web layer
     * echoes it back through onProgressSaved() once the CLOUD save succeeded, and only that
     * confirmation clears the record (MainActivity.confirmProgressSaved) — a fire-and-forget
     * failure no longer loses the position.
     */
    private void writePendingProgress(long pos, long dur) {
        long savedAt = System.currentTimeMillis();
        getSharedPreferences("norva", MODE_PRIVATE).edit()
                .putString("pending_progress_sourceId", sourceId == null ? "" : sourceId)
                .putString("pending_progress_itemType", itemType == null ? "" : itemType)
                .putString("pending_progress_itemId", itemId)
                .putLong("pending_progress_pos", pos)
                .putLong("pending_progress_dur", dur)
                .putLong("pending_progress_savedAt", savedAt)
                .putString("pending_progress_token", Long.toString(savedAt))
                .apply();
    }

    @Override
    protected void onStart() {
        super.onStart();
        activityForeground = true;
        applyPlaybackIntent();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityForeground = true;
        applyPlaybackIntent();
    }

    @Override
    protected void onPause() {
        activityForeground = false;
        maybePersistProgress(true);
        applyPlaybackIntent();
        super.onPause();
    }

    @Override
    protected void onStop() {
        activityForeground = false;
        maybePersistProgress(true);
        applyPlaybackIntent();
        super.onStop();
    }

    private boolean isActuallyInPictureInPicture() {
        return android.os.Build.VERSION.SDK_INT >= 26 && isInPictureInPictureMode();
    }

    /**
     * Hand the final position back to MainActivity (which persists it to the
     * cloud history for cross-device resume). Called on every exit path: Back,
     * end-of-stream, and the sleep timer.
     */
    @Override
    public void finish() {
        try {
            clearFreshStreamRequest(true);
            android.content.Intent data = null;
            if (player != null && itemId != null && !itemId.isEmpty()) {
                long pos = Math.max(0, player.getCurrentPosition() / 1000);
                long dur = player.getDuration() > 0 ? player.getDuration() / 1000 : 0;
                data = new android.content.Intent();
                data.putExtra("sourceId", sourceId);
                data.putExtra("itemType", itemType);
                data.putExtra("itemId", itemId);
                data.putExtra("positionSeconds", pos);
                data.putExtra("durationSeconds", dur);
                data.putExtra("ended", endedNaturally);
                data.putExtra("playNext", playNextChosen);
                data.putExtra("openEpisodes", openEpisodesChosen);
                data.putExtra("retryPlayback", freshStreamRequested);
                if (freshStreamReason != null) data.putExtra("retryReason", freshStreamReason);
                if (cancelledRecoveryTokenForResult != null
                        && !cancelledRecoveryTokenForResult.isEmpty()) {
                    data.putExtra(EXTRA_RECOVERY_TOKEN, cancelledRecoveryTokenForResult);
                }
                String dirtyTrackPreferences = dirtyTrackPreferencesJson();
                if (dirtyTrackPreferences != null && !dirtyTrackPreferences.isEmpty()) {
                    data.putExtra("trackPreferences", dirtyTrackPreferences);
                }
                // Graceful exit: persist the FINAL position into the SharedPreferences net and
                // KEEP it there — it is only cleared once the web layer confirms the cloud save
                // (onProgressSaved). Clearing here used to lose the position whenever the
                // fire-and-forget save failed: network blip at exit, WebView sitting on
                // cloud-pair.html after a device-token revoke, PiP closed as the process died
                // (sync audit 2026-07-17 P1 n°1). gracefulResultEmitted stops onPause/onStop
                // from re-writing an older heartbeat position over this final one.
                gracefulResultEmitted = true;
                if (pos > 0) writePendingProgress(pos, dur);
            }
            // A variant pick returns here so MainActivity can ask the web to re-select it.
            if (pendingVariantStreamId != null && !pendingVariantStreamId.isEmpty()) {
                if (data == null) data = new android.content.Intent();
                data.putExtra("selectedVariantStreamId", pendingVariantStreamId);
                data.putExtra("selectedVariantSourceId", pendingVariantSourceId);
            }
            if (data != null) setResult(RESULT_OK, data);
        } catch (Exception ignored) { /* result is best-effort */ }
        super.finish();
    }

    @Override
    protected void onDestroy() {
        playbackAuthToken = null;
        clearFreshStreamRequest(true);
        handler.removeCallbacksAndMessages(null);
        if (freshStreamReceiver != null) {
            try { unregisterReceiver(freshStreamReceiver); } catch (Exception ignored) { }
            freshStreamReceiver = null;
        }
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
