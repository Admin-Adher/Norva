package tv.norva.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
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

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

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
    private TextView subtitleView;
    private ProgressBar spinner;
    private TextView errorView;

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

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean controlsVisible = true;
    private boolean secondBarVisible = false;
    private boolean userSeeking = false;

    private int videoW = 0, videoH = 0;
    private int playRetries = 0; // one reconnect of the active lane before changing transport
    private int recoveryGeneration = 0; // invalidates delayed reconnects after a newer recovery action
    private int aspectMode = 0; // 0 fit, 1 zoom (crop), 2 stretch
    private final String[] ASPECT_LABELS = {"Normal", "Zoom", "Stretch"};
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
        try {
            String vj = getIntent().getStringExtra(EXTRA_VARIANTS);
            if (vj != null && !vj.isEmpty()) {
                org.json.JSONArray arr = new org.json.JSONArray(vj);
                if (arr.length() > 1) variants = arr;
            }
        } catch (Exception ignored) { variants = null; }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        surfaceView = new SurfaceView(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));

        subtitleView = new TextView(this);
        subtitleView.setTextColor(Color.WHITE);
        subtitleView.setTextSize(24);
        subtitleView.setGravity(Gravity.CENTER);
        subtitleView.setShadowLayer(5, 0, 2, Color.BLACK);
        subtitleView.setBackgroundColor(Color.parseColor("#66000000"));
        subtitleView.setPadding(dp(14), dp(4), dp(14), dp(4));
        subtitleView.setVisibility(View.GONE);
        FrameLayout.LayoutParams subLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        subLp.bottomMargin = dp(64);
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
                    // Restore the viewer's last subtitle choice for this title
                    // once the track list is known (no-op if none was saved).
                    maybeRestoreSubtitlePref();
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
                errorView.setTextColor(Color.parseColor("#ef4444"));
                errorView.setText(friendlyError(code));
                errorView.setVisibility(View.VISIBLE);
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
                StringBuilder text = new StringBuilder();
                for (Cue cue : cueGroup.cues) {
                    if (cue.text != null) {
                        if (text.length() > 0) text.append('\n');
                        text.append(cue.text);
                    }
                }
                if (text.length() > 0) {
                    subtitleView.setText(text.toString());
                    subtitleView.setVisibility(View.VISIBLE);
                } else {
                    subtitleView.setVisibility(View.GONE);
                }
            }
        });

        playRetries = 0;
        player.setMediaItem(MediaItem.fromUri(url));
        player.prepare();
        player.setPlayWhenReady(true);
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
                    player.setPlayWhenReady(true);
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
                player.setPlayWhenReady(true);
            }
        }, delay);
    }

    /**
     * Both the direct provider URL and its signed fallback were exhausted. Hand
     * the exact item + position back to the still-open WebView so it resolves a
     * fresh provider URL/session and relaunches without navigating to Home.
     */
    private void requestFreshStream(String reason) {
        if (freshStreamRequested) return;
        recoveryGeneration++;
        if (sourceId == null || sourceId.isEmpty() || itemId == null || itemId.isEmpty()) {
            spinner.setVisibility(View.GONE);
            errorView.setText("Playback was interrupted.\nTry again in a moment.");
            errorView.setVisibility(View.VISIBLE);
            reportPlaybackStatus("broken", reason);
            return;
        }
        freshStreamRequested = true;
        freshStreamReason = reason;
        errorView.setText("Reconnecting…");
        errorView.setVisibility(View.VISIBLE);
        reportPlaybackStatus("reconnecting", reason);
        handler.postDelayed(new Runnable() {
            @Override public void run() { finish(); }
        }, 350L);
    }

    /** Reload from the gateway fallback URL after a direct-URL refusal (e.g. provider 401). */
    private void switchToFallback() {
        recoveryGeneration++;
        fallbackTried = true;
        playRetries = 0;
        streamHost = hostOf(fallbackUrl);
        handler.removeCallbacks(bufferWatchdog);
        errorView.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        long position = recoverPositionMs();
        player.setMediaItem(MediaItem.fromUri(fallbackUrl), position);
        player.prepare();
        player.setPlayWhenReady(true);
    }

    // ==================== Overlay ====================

    private void buildOverlay(String title) {
        overlay = new FrameLayout(this);
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // Clock — top right
        clockView = new TextView(this);
        clockView.setTextColor(ACCENT);
        clockView.setTextSize(16);
        clockView.setPadding(dp(24), dp(18), dp(28), dp(18));
        updateClock();
        overlay.addView(clockView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.END));

        // Bottom panel
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setBackgroundColor(PANEL);
        bottom.setPadding(dp(28), dp(14), dp(28), dp(10));
        overlay.addView(bottom, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

        titleView = new TextView(this);
        titleView.setText(title == null ? "" : title);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(20);
        titleView.setPadding(0, 0, 0, dp(8));
        bottom.addView(titleView);

        seekBar = new SeekBar(this);
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
        timeView.setTextColor(SUBTLE);
        timeView.setTextSize(15);
        FrameLayout.LayoutParams timeLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.START | Gravity.CENTER_VERTICAL);
        controlRow.addView(timeView, timeLp);

        LinearLayout transport = new LinearLayout(this);
        transport.setOrientation(LinearLayout.HORIZONTAL);
        transport.setGravity(Gravity.CENTER_VERTICAL);
        controlRow.addView(transport, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL));

        addCircleIcon(transport, R.drawable.ic_player_skip_back, "Back 10 seconds", 48, false, new Runnable() {
            @Override public void run() { seekBy(-10000); }
        });
        playPauseBtn = addCircleIcon(transport, R.drawable.ic_player_pause, "Play/Pause", 64, true, new Runnable() {
            @Override public void run() { togglePlay(); }
        });
        addCircleIcon(transport, R.drawable.ic_player_skip_forward, "Forward 10 seconds", 48, false, new Runnable() {
            @Override public void run() { seekBy(10000); }
        });

        // Chevron is a purely visual indicator of the second bar's state. On TV
        // it is NOT focusable: D-pad Down from the transport already opens the
        // options bar, and Up from the options closes it, so the chevron could
        // never receive focus anyway. Kept as a touch affordance (phone/mouse).
        chevron = makePlainIconButton(R.drawable.ic_player_expand_more, "Player options", 44, 10, ACCENT);
        chevron.setFocusable(false);
        chevron.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggleSecondBar(); }
        });
        LinearLayout chevronWrap = new LinearLayout(this);
        chevronWrap.setGravity(Gravity.CENTER_HORIZONTAL);
        chevronWrap.addView(chevron);
        bottom.addView(chevronWrap, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        buildSecondBar(bottom);

        playPauseBtn.requestFocus();
    }

    private void buildSecondBar(LinearLayout parent) {
        // Up to 8 items (Video/Audio/Subs/Aspect/Speed/Sleep/Version/Next/Episodes):
        // on a small TV they would otherwise compress. A HorizontalScrollView keeps
        // each item at full size and lets focus auto-scroll the row into view;
        // fillViewport + child MATCH_PARENT still centers the row when it fits.
        HorizontalScrollView scroller = new HorizontalScrollView(this);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.setFillViewport(true);
        parent.addView(scroller, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        secondBar = new LinearLayout(this);
        secondBar.setOrientation(LinearLayout.HORIZONTAL);
        secondBar.setGravity(Gravity.CENTER);
        secondBar.setPadding(0, dp(6), 0, dp(6));
        secondBar.setVisibility(View.GONE);
        scroller.addView(secondBar, new HorizontalScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        videoValue = addBarItem(R.drawable.ic_player_quality, "Video", "—", new Runnable() {
            @Override public void run() { showTrackDialog(C.TRACK_TYPE_VIDEO, "Video track"); }
        });
        audioValue = addBarItem(R.drawable.ic_player_audio, "Audio", "—", new Runnable() {
            @Override public void run() { showTrackDialog(C.TRACK_TYPE_AUDIO, "Audio track"); }
        });
        subValue = addBarItem(R.drawable.ic_player_captions, "Subtitles", "Off", new Runnable() {
            @Override public void run() { showTrackDialog(C.TRACK_TYPE_TEXT, "Subtitles"); }
        });
        aspectValue = addBarItem(R.drawable.ic_player_pip, "Aspect", ASPECT_LABELS[0], new Runnable() {
            @Override public void run() { cycleAspect(); }
        });
        speedValue = addBarItem(R.drawable.ic_player_speed, "Speed", "1×", new Runnable() {
            @Override public void run() { cycleSpeed(); }
        });
        sleepValue = addBarItem(R.drawable.ic_player_sleep, "Sleep", "Off", new Runnable() {
            @Override public void run() { cycleSleep(); }
        });
        // Live-only: switch the channel's quality variant (M6 HD/RAW/HEVC...). Present
        // only when the web handed us >1 variant.
        if (variants != null) {
            addBarItem(R.drawable.ic_player_quality, "Version", currentVariantLabel(), new Runnable() {
                @Override public void run() { showVariantDialog(); }
            });
        }
        // Series-only shortcuts: jump to the next episode without waiting for the
        // end, and reopen the episode list (the fiche behind the player).
        if (nextTitle != null && !nextTitle.isEmpty()) {
            addBarItem(R.drawable.ic_player_skip_forward, "Next", "Episode", new Runnable() {
                @Override public void run() { chooseNextEpisode(); }
            });
        }
        if ("episode".equals(itemType)) {
            addBarItem(R.drawable.ic_player_expand_less, "Episodes", "List", new Runnable() {
                @Override public void run() { openEpisodesList(); }
            });
        }
    }

    /** One second-bar entry: icon on top, caption + live value below. */
    private TextView addBarItem(int iconRes, String caption, String value, final Runnable action) {
        LinearLayout item = new LinearLayout(this);
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
        if (player.isPlaying()) player.pause(); else player.play();
        updatePlayPauseLabel();
        scheduleHideControls();
    }

    private void updatePlayPauseLabel() {
        if (playPauseBtn != null) {
            playPauseBtn.setImageResource(player != null && player.isPlaying()
                    ? R.drawable.ic_player_pause
                    : R.drawable.ic_player_play);
        }
    }

    private void cycleAspect() {
        aspectMode = (aspectMode + 1) % ASPECT_LABELS.length;
        aspectValue.setText(ASPECT_LABELS[aspectMode]);
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
            if (aspectMode == 2) {
                surfaceView.setScaleX(1f);
                surfaceView.setScaleY(1f);
                surfaceView.setTranslationX(0f);
                surfaceView.setTranslationY(0f);
                surfaceView.setLayoutParams(new FrameLayout.LayoutParams(
                        rootW, rootH, Gravity.CENTER));
            }
            return;
        }
        double videoAspect = (double) videoW / videoH;
        double rootAspect = (double) rootW / rootH;
        int w, h;
        if (aspectMode == 2) {            // stretch/fill the panel
            w = rootW; h = rootH;
        } else if (aspectMode == 1) {     // zoom / crop
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

    private void showTrackDialog(final int trackType, String title) {
        Tracks tracks = player.getCurrentTracks();
        final List<String> labels = new ArrayList<>();
        final List<Tracks.Group> groups = new ArrayList<>();
        final List<Integer> indices = new ArrayList<>();

        final boolean isText = trackType == C.TRACK_TYPE_TEXT;
        if (isText) { labels.add("Off"); groups.add(null); indices.add(-1); }

        int selected = isText ? 0 : -1;
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != trackType) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                labels.add(describeTrack(group.getTrackFormat(i), trackType, labels.size()));
                groups.add(group);
                indices.add(i);
                if (group.isTrackSelected(i)) selected = labels.size() - 1;
            }
        }

        if (labels.size() <= (isText ? 1 : 0)) {
            toast(isText ? "No subtitles in this stream" : "No other track");
            return;
        }

        new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle(title)
                .setSingleChoiceItems(labels.toArray(new String[0]), selected,
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                // A manual pick is authoritative: don't let a later
                                // STATE_READY re-apply the previously saved choice.
                                if (trackType == C.TRACK_TYPE_TEXT) subPrefRestored = true;
                                applyTrack(trackType, groups.get(which), indices.get(which));
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
        String audio = "—";
        String sub = "Off";
        for (Tracks.Group g : tracks.getGroups()) {
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSelected(i)) continue;
                Format f = g.getTrackFormat(i);
                if (g.getType() == C.TRACK_TYPE_AUDIO) audio = shortAudio(f);
                else if (g.getType() == C.TRACK_TYPE_TEXT) sub = shortLang(f);
            }
        }
        if (videoValue != null) videoValue.setText(video);
        if (audioValue != null) audioValue.setText(audio);
        if (subValue != null) subValue.setText(sub);
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
            chevron.setImageResource(R.drawable.ic_player_expand_less);
            refreshSecondBarValues();
        }
        if (secondBar.getChildCount() > 0) secondBar.getChildAt(0).requestFocus();
        scheduleHideControls();
    }

    private void closeSecondBar() {
        secondBarVisible = false;
        secondBar.setVisibility(View.GONE);
        chevron.setImageResource(R.drawable.ic_player_expand_more);
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
        chevron.setImageResource(R.drawable.ic_player_expand_more);
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
            finish();
            return true;
        }
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY
                || code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            togglePlay(); showControls(); return true;
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
                    togglePlay(); showControls(playPauseBtn); return true;    // OK → pause + reveal
                default:
                    showControls(playPauseBtn); return true;  // anything else → reveal transport
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
        chevron.setImageResource(R.drawable.ic_player_expand_more);
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
                MainActivity main = MainActivity.current;
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
    protected void onPause() {
        super.onPause();
        maybePersistProgress(true);
    }

    @Override
    protected void onStop() {
        super.onStop();
        maybePersistProgress(true);
    }

    /**
     * Hand the final position back to MainActivity (which persists it to the
     * cloud history for cross-device resume). Called on every exit path: Back,
     * end-of-stream, and the sleep timer.
     */
    @Override
    public void finish() {
        try {
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
        handler.removeCallbacksAndMessages(null);
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
