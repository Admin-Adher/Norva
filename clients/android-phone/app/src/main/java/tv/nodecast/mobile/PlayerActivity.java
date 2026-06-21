package tv.nodecast.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
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
    // Offline (encrypted local file) playback.
    public static final String EXTRA_LOCAL = "local";
    public static final String EXTRA_WRAPPED_KEY = "wrappedKey";
    public static final String EXTRA_KEY_IV = "keyIv";
    public static final String EXTRA_MEDIA_IV = "mediaIv";
    public static final String EXTRA_CONTAINER = "container";

    // Browser-style UA: some IPTV providers reject unknown agents (401/403).
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    private ExoPlayer player;
    private PlayerView playerView;
    private String sourceId;
    private String itemType;
    private String itemId;
    private int resumeSeconds = 0;
    private boolean resumeApplied = false;

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
        if (url == null || url.isEmpty()) { finish(); return; }

        playerView = new PlayerView(this);
        // Black everywhere behind the video so letterbox/pillarbox and any
        // cutout-safe insets read as clean black bars, never the theme's grey.
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        playerView.setBackgroundColor(Color.BLACK);
        playerView.setShutterBackgroundColor(Color.BLACK);
        setContentView(playerView);

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

        boolean local = getIntent().getBooleanExtra(EXTRA_LOCAL, false);
        DataSource.Factory dataSourceFactory;
        if (local) {
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
                .build();
        playerView.setPlayer(player);
        playerView.setKeepScreenOn(true);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY && !resumeApplied && resumeSeconds > 0) {
                    resumeApplied = true;
                    long target = resumeSeconds * 1000L;
                    long duration = player.getDuration();
                    if (duration <= 0 || target < duration - 5000) {
                        player.seekTo(target);
                    }
                }
                if (state == Player.STATE_ENDED) finish();
            }
        });

        MediaItem.Builder mediaItem = new MediaItem.Builder().setUri(url);
        if (local) {
            // The file extension is hidden (.enc); give ExoPlayer a MIME hint so
            // it picks the right extractor (it also sniffs the decrypted bytes).
            String mime = mimeForContainer(getIntent().getStringExtra(EXTRA_CONTAINER));
            if (mime != null) mediaItem.setMimeType(mime);
        }
        player.setMediaItem(mediaItem.build());
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
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }
}
