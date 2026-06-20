package tv.nodecast.client;

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
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

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

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SOURCE_ID = "sourceId";
    public static final String EXTRA_ITEM_TYPE = "itemType";
    public static final String EXTRA_ITEM_ID = "itemId";
    public static final String EXTRA_RESUME_SECONDS = "resumeSeconds";

    // Browser-style UA: some IPTV providers reject unknown agents (403/406)
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    private static final int ACCENT = Color.parseColor("#818CF8");
    private static final int PANEL = Color.parseColor("#CC0A0A0F");
    private static final int SUBTLE = Color.parseColor("#B4B4C0");

    private ExoPlayer player;
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
    private int playRetries = 0; // transient-error retry budget per stream
    private int aspectMode = 0; // 0 fit, 1 zoom (crop), 2 stretch
    private final String[] ASPECT_LABELS = {"Normal", "Zoom", "Étirer"};
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

    private final SimpleDateFormat clockFmt = new SimpleDateFormat("EEE d MMM 'à' HH:mm", Locale.FRENCH);

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

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            updateProgress();
            updateClock();
            handler.postDelayed(this, 500);
        }
    };

    private final Runnable sleepRunnable = new Runnable() {
        @Override
        public void run() { finish(); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        sourceId = getIntent().getStringExtra(EXTRA_SOURCE_ID);
        itemType = getIntent().getStringExtra(EXTRA_ITEM_TYPE);
        itemId = getIntent().getStringExtra(EXTRA_ITEM_ID);
        resumeSeconds = getIntent().getIntExtra(EXTRA_RESUME_SECONDS, 0);
        if (url == null || url.isEmpty()) { finish(); return; }

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

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
                .build();
        player.setVideoSurfaceView(surfaceView);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                spinner.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                if (state == Player.STATE_READY) {
                    playRetries = 0;           // healthy playback resets the retry budget
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
                }
                if (state == Player.STATE_ENDED) finish();
                updatePlayPauseLabel();
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) { updatePlayPauseLabel(); }

            @Override
            public void onPlayerError(PlaybackException error) {
                final int code = error.errorCode;
                // Transient network/HTTP errors (incl. a 504 or a briefly held
                // single-connection slot): retry once before giving up.
                boolean transientIo = code >= PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                        && code < PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED;
                if (transientIo && playRetries < 1 && player != null) {
                    playRetries++;
                    spinner.setVisibility(View.VISIBLE);
                    errorView.setVisibility(View.GONE);
                    handler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            if (player != null) { player.prepare(); player.play(); }
                        }
                    }, 1500);
                    return;
                }
                spinner.setVisibility(View.GONE);
                errorView.setText(friendlyError(code, error.getErrorCodeName()));
                errorView.setVisibility(View.VISIBLE);
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

    /** Map ExoPlayer error codes to clear French messages for the viewer. */
    private String friendlyError(int code, String name) {
        if (code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) {
            return "Flux refusé ou serveur du fournisseur indisponible.\n"
                    + "La chaîne/le titre est peut-être hors-ligne, ou votre compte est limité à une connexion.";
        }
        if (code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) {
            return "Connexion au flux impossible (réseau ou serveur trop lent).";
        }
        if (code == PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
                || code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED
                || code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED) {
            return "Ce titre est indisponible chez le fournisseur\n(le serveur ne renvoie pas de vidéo valide).";
        }
        if (code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED) {
            return "Format vidéo/audio non pris en charge par cette TV.";
        }
        return "Lecture impossible (" + name + ").";
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

        // Chevron toggles the second bar (remote uses DPAD up/down instead)
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
        secondBar = new LinearLayout(this);
        secondBar.setOrientation(LinearLayout.HORIZONTAL);
        secondBar.setGravity(Gravity.CENTER);
        secondBar.setPadding(0, dp(6), 0, dp(6));
        secondBar.setVisibility(View.GONE);
        parent.addView(secondBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        videoValue = addBarItem(R.drawable.ic_player_quality, "Vidéo", "—", new Runnable() {
            @Override public void run() { showTrackDialog(C.TRACK_TYPE_VIDEO, "Piste vidéo"); }
        });
        audioValue = addBarItem(R.drawable.ic_player_audio, "Audio", "—", new Runnable() {
            @Override public void run() { showTrackDialog(C.TRACK_TYPE_AUDIO, "Piste audio"); }
        });
        subValue = addBarItem(R.drawable.ic_player_captions, "Sous-titres", "Off", new Runnable() {
            @Override public void run() { showTrackDialog(C.TRACK_TYPE_TEXT, "Sous-titres"); }
        });
        aspectValue = addBarItem(R.drawable.ic_player_pip, "Ratio", ASPECT_LABELS[0], new Runnable() {
            @Override public void run() { cycleAspect(); }
        });
        speedValue = addBarItem(R.drawable.ic_player_speed, "Vitesse", "1×", new Runnable() {
            @Override public void run() { cycleSpeed(); }
        });
        sleepValue = addBarItem(R.drawable.ic_player_sleep, "Veille", "Off", new Runnable() {
            @Override public void run() { cycleSleep(); }
        });
    }

    /** One second-bar entry: icon on top, caption + live value below. */
    private TextView addBarItem(int iconRes, String caption, String value, final Runnable action) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(18), dp(8), dp(18), dp(8));
        makeFocusable(item, 0);
        item.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { action.run(); }
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
        if (videoW <= 0 || videoH <= 0) return;
        final int rootW = root.getWidth();
        final int rootH = root.getHeight();
        if (rootW == 0 || rootH == 0) {
            root.post(new Runnable() { @Override public void run() { applyAspect(); } });
            return;
        }
        double videoAspect = (double) videoW / videoH;
        double rootAspect = (double) rootW / rootH;
        int w, h;
        if (aspectMode == 2) {            // stretch
            w = rootW; h = rootH;
        } else if (aspectMode == 1) {     // zoom / crop
            if (videoAspect > rootAspect) { h = rootH; w = (int) (rootH * videoAspect); }
            else { w = rootW; h = (int) (rootW / videoAspect); }
        } else {                          // fit (letterbox)
            if (videoAspect > rootAspect) { w = rootW; h = (int) (rootW / videoAspect); }
            else { h = rootH; w = (int) (rootH * videoAspect); }
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, h, Gravity.CENTER);
        surfaceView.setLayoutParams(lp);
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
            toast(isText ? "Aucun sous-titre dans ce flux" : "Aucune autre piste");
            return;
        }

        new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle(title)
                .setSingleChoiceItems(labels.toArray(new String[0]), selected,
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                applyTrack(trackType, groups.get(which), indices.get(which));
                                dialog.dismiss();
                                refreshSecondBarValues();
                                scheduleHideControls();
                            }
                        })
                .show();
    }

    private void applyTrack(int trackType, Tracks.Group group, int trackIndex) {
        if (group == null) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(trackType, true).build());
            subtitleView.setVisibility(View.GONE);
            return;
        }
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(trackType, false)
                .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), trackIndex))
                .build());
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
        else s.append(trackType == C.TRACK_TYPE_AUDIO ? "Audio " : "Sous-titre ").append(ordinal);
        if (f.language != null && !"und".equals(f.language)) s.append(" [").append(f.language).append("]");
        if (trackType == C.TRACK_TYPE_AUDIO) {
            if (f.channelCount == 6) s.append(" · 5.1");
            else if (f.channelCount == 8) s.append(" · 7.1");
            else if (f.channelCount == 2) s.append(" · stéréo");
            if (f.codecs != null) s.append(" · ").append(f.codecs);
        }
        return s.toString();
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

        if (code == KeyEvent.KEYCODE_BACK) {
            if (secondBarVisible) { closeSecondBar(); return true; }
            if (controlsVisible) { hideOverlayNow(); return true; }
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
                default:
                    showControls(playPauseBtn); return true;  // center / anything → reveal transport
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

    /**
     * Hand the final position back to MainActivity (which persists it to the
     * cloud history for cross-device resume). Called on every exit path: Back,
     * end-of-stream, and the sleep timer.
     */
    @Override
    public void finish() {
        try {
            if (player != null && itemId != null && !itemId.isEmpty()) {
                long pos = Math.max(0, player.getCurrentPosition() / 1000);
                long dur = player.getDuration() > 0 ? player.getDuration() / 1000 : 0;
                android.content.Intent data = new android.content.Intent();
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
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
