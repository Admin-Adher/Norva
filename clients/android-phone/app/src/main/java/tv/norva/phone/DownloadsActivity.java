package tv.norva.phone;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.util.LruCache;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.Window;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.text.NumberFormat;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import tv.norva.analytics.NativeClarity;

/**
 * Native "Downloads" screen — the offline library, styled to match the Norva
 * web app. Movies show as cards; episodes are grouped under their show. Each
 * item exposes the controls valid for its state (play / pause / resume / move /
 * retry / cancel-delete). A header shows storage use, the active download, and a
 * Wi-Fi-only toggle. Rebuilt on a light poll only when something changes.
 */
public final class DownloadsActivity extends Activity {

    private static final int BG = Color.parseColor("#0a0a0f");
    private static final int CARD = Color.parseColor("#15151d");
    private static final int CARD_BORDER = Color.parseColor("#23232e");
    private static final int ACCENT = Color.parseColor("#3B82F6");
    private static final int SUBTLE = Color.parseColor("#22222c");
    private static final int TEXT = Color.WHITE;
    private static final int MUTED = Color.parseColor("#a1a1aa");
    private static final int DANGER = Color.parseColor("#ef4444");

    private static final Pattern SXEY = Pattern.compile("(?i)S(\\d{1,3})\\s*E(\\d{1,4})");

    private LinearLayout list;
    private TextView empty;
    private TextView summary;
    private TextView active;
    private TextView clearAll;
    private String lastStructureSignature;
    private String lastContentSignature;
    private Snapshot currentSnapshot;
    private final Map<String, TextView> statusViews = new LinkedHashMap<>();
    private final Map<String, Integer> announcedProgressBuckets = new LinkedHashMap<>();
    private final Set<String> announcedFailures = new HashSet<>();
    /** Seasons the user has collapsed, keyed "showTitle|season"; survives re-render. */
    private final Set<String> collapsed = new HashSet<>();

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService refreshExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService mutationExecutor = Executors.newSingleThreadExecutor();
    private final Object refreshLock = new Object();
    private Future<?> refreshFuture;
    private boolean refreshInFlight;
    private boolean refreshQueued;
    private boolean forceQueuedRefresh;
    private int pendingMutationCount;
    private boolean lifecycleActive;
    private long lifecycleGeneration;
    private long mutationGeneration;
    private long issuedRefreshSequence;
    private long committedRefreshSequence;
    private long refreshTaskToken;
    private final LruCache<String, Bitmap> posterCache =
            new LruCache<String, Bitmap>(12 * 1024 * 1024) {
                @Override
                protected int sizeOf(String key, Bitmap value) {
                    return value == null ? 0 : value.getAllocationByteCount();
                }
            };
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!lifecycleActive) return;
            requestRefresh(false);
            handler.postDelayed(this, 1500L);
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        NativeClarity.configure(BuildConfig.CLARITY_PROJECT_ID, "android_mobile", BuildConfig.VERSION_NAME, BuildConfig.DEBUG ? "qa" : "production");
        NativeClarity.applyStoredConsent(this);
        NativeClarity.screen("downloads");
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        scroll.setFitsSystemWindows(Build.VERSION.SDK_INT < 30);

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(dp(18), dp(30), dp(18), dp(24));
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars()
                                | android.view.WindowInsets.Type.displayCutout());
                container.setPadding(
                        dp(18) + safe.left,
                        dp(30) + safe.top,
                        dp(18) + safe.right,
                        dp(24) + safe.bottom);
                return insets;
            });
            scroll.requestApplyInsets();
        }

        // Header row: title + Close.
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText(R.string.downloads_title);
        title.setTextColor(TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView close = pill(getString(R.string.downloads_close), SUBTLE, TEXT);
        close.setOnClickListener(v -> finish());
        header.addView(close);
        container.addView(header);

        summary = new TextView(this);
        summary.setTextColor(MUTED);
        summary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        summary.setPadding(0, dp(3), 0, 0);
        container.addView(summary);

        active = new TextView(this);
        active.setTextColor(Color.parseColor("#cdd9ff"));
        active.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        active.setPadding(0, dp(2), 0, 0);
        active.setVisibility(View.GONE);
        // Progress is announced explicitly at useful 10% boundaries below.
        // Avoid a live-region announcement for every 1.5 s byte update.
        active.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_NONE);
        container.addView(active);

        // Wi-Fi-only: dedicated setting row (label + subtitle + accent-styled switch),
        // separate from the destructive "Clear all" action.
        LinearLayout wifiRow = new LinearLayout(this);
        wifiRow.setOrientation(LinearLayout.HORIZONTAL);
        wifiRow.setGravity(Gravity.CENTER_VERTICAL);
        wifiRow.setBackground(roundedStroke(CARD, CARD_BORDER, 12));
        wifiRow.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout wifiText = new LinearLayout(this);
        wifiText.setOrientation(LinearLayout.VERTICAL);
        TextView wifiLabel = new TextView(this);
        final String wifiLabelText = getString(R.string.downloads_wifi_only);
        final String wifiDescription = getString(R.string.downloads_wifi_only_description);
        wifiLabel.setText(wifiLabelText);
        wifiLabel.setTextColor(TEXT);
        wifiLabel.setTypeface(Typeface.DEFAULT_BOLD);
        wifiLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        TextView wifiSub = new TextView(this);
        wifiSub.setText(R.string.downloads_wifi_only_subtitle);
        wifiSub.setTextColor(MUTED);
        wifiSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        wifiSub.setPadding(0, dp(2), 0, 0);
        wifiText.addView(wifiLabel);
        wifiText.addView(wifiSub);
        wifiRow.addView(wifiText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        // Custom-drawn toggle — NOT the platform android.widget.Switch, which OEM
        // skins (e.g. MIUI/Xiaomi) restyle into an unusable faint blob with stray
        // "ON/ACTIVE" text and no visible thumb. This draws itself, so it looks and
        // behaves identically on every device. The WHOLE ROW is tappable too, so the
        // control is obvious and easy to hit. ON = Wi-Fi only; tap to turn OFF and
        // allow downloads on mobile data.
        Toggle wifi = new Toggle(this, DownloadService.getWifiOnly(this), ACCENT, 0xFF3F3F46, 0xFFF4F4F5);
        View.OnClickListener flip = v -> {
            boolean nv = !wifi.isChecked();
            wifi.setChecked(nv);
            DownloadService.setWifiOnly(this, nv);
            mutationGeneration++;
            syncToggleAccessibility(
                    wifiRow,
                    wifi,
                    wifiLabelText,
                    wifiDescription);
            wifiRow.announceForAccessibility(getString(
                    nv ? R.string.downloads_wifi_only_on : R.string.downloads_wifi_only_off));
            renderNow();
        };
        wifiRow.setOnClickListener(flip);
        configureToggleRow(
                wifiRow,
                wifi,
                wifiLabelText,
                wifiDescription);
        LinearLayout.LayoutParams wifiTogLp = new LinearLayout.LayoutParams(dp(48), dp(28));
        wifiTogLp.leftMargin = dp(12);
        wifiRow.addView(wifi, wifiTogLp);
        LinearLayout.LayoutParams wifiRowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wifiRowLp.topMargin = dp(14);
        container.addView(wifiRow, wifiRowLp);

        // Smart downloads: finished episode -> its follower joins the queue
        // automatically (payload attached by the web at enqueue time).
        LinearLayout smartRow = new LinearLayout(this);
        smartRow.setOrientation(LinearLayout.HORIZONTAL);
        smartRow.setGravity(Gravity.CENTER_VERTICAL);
        smartRow.setBackground(roundedStroke(CARD, CARD_BORDER, 12));
        smartRow.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout smartText = new LinearLayout(this);
        smartText.setOrientation(LinearLayout.VERTICAL);
        TextView smartLabel = new TextView(this);
        final String smartLabelText = getString(R.string.downloads_smart);
        final String smartDescription = getString(R.string.downloads_smart_description);
        smartLabel.setText(smartLabelText);
        smartLabel.setTextColor(TEXT);
        smartLabel.setTypeface(Typeface.DEFAULT_BOLD);
        smartLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        TextView smartSub = new TextView(this);
        smartSub.setText(R.string.downloads_smart_subtitle);
        smartSub.setTextColor(MUTED);
        smartSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        smartSub.setPadding(0, dp(2), 0, 0);
        smartText.addView(smartLabel);
        smartText.addView(smartSub);
        smartRow.addView(smartText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Toggle smart = new Toggle(this, DownloadService.getSmartDownloads(this), ACCENT, 0xFF3F3F46, 0xFFF4F4F5);
        View.OnClickListener smartFlip = v -> {
            boolean nv = !smart.isChecked();
            smart.setChecked(nv);
            DownloadService.setSmartDownloads(this, nv);
            syncToggleAccessibility(
                    smartRow,
                    smart,
                    smartLabelText,
                    smartDescription);
            smartRow.announceForAccessibility(getString(
                    nv ? R.string.downloads_smart_on : R.string.downloads_smart_off));
        };
        smartRow.setOnClickListener(smartFlip);
        configureToggleRow(
                smartRow,
                smart,
                smartLabelText,
                smartDescription);
        LinearLayout.LayoutParams smartTogLp = new LinearLayout.LayoutParams(dp(48), dp(28));
        smartTogLp.leftMargin = dp(12);
        smartRow.addView(smart, smartTogLp);
        LinearLayout.LayoutParams smartRowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        smartRowLp.topMargin = dp(10);
        container.addView(smartRow, smartRowLp);

        LinearLayout clearRow = new LinearLayout(this);
        clearRow.setOrientation(LinearLayout.HORIZONTAL);
        clearRow.setGravity(Gravity.END);
        clearRow.setPadding(0, dp(10), 0, dp(2));
        clearAll = pill(getString(R.string.downloads_clear_all), SUBTLE, MUTED);
        clearAll.setContentDescription(getString(R.string.downloads_clear_all_description));
        clearAll.setOnClickListener(v -> confirmClearAll());
        setClearAllEnabled(false);
        clearRow.addView(clearAll);
        container.addView(clearRow);

        empty = new TextView(this);
        empty.setText(R.string.downloads_empty);
        empty.setTextColor(MUTED);
        empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(0, dp(56), 0, 0);
        container.addView(empty);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, dp(14), 0, 0);
        container.addView(list);

        scroll.addView(container);
        setContentView(scroll);
        NativeClarity.registerSensitiveView(scroll);
    }

    /**
     * A self-drawn on/off toggle. We deliberately avoid the platform
     * {@link android.widget.Switch}: OEM skins (notably MIUI) re-theme it into a
     * faint, near-invisible control with stray "ON/ACTIVE" text and no clear thumb,
     * which left users unable to find the setting. This view owns its own drawing,
     * so it renders identically everywhere. Fixed size; tap handling is wired by the
     * caller (both the toggle and the whole row flip it).
     */
    static final class Toggle extends View {
        private boolean checked;
        private final int onColor, offColor, thumbColor;
        private final android.graphics.Paint paint =
                new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final float density;

        Toggle(android.content.Context c, boolean checked, int onColor, int offColor, int thumbColor) {
            super(c);
            this.checked = checked;
            this.onColor = onColor;
            this.offColor = offColor;
            this.thumbColor = thumbColor;
            this.density = c.getResources().getDisplayMetrics().density;
        }

        boolean isChecked() { return checked; }

        void setChecked(boolean v) {
            if (v != checked) { checked = v; invalidate(); }
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            setMeasuredDimension(
                    resolveSize(Math.round(48 * density), widthSpec),
                    resolveSize(Math.round(28 * density), heightSpec));
        }

        @Override
        protected void onDraw(android.graphics.Canvas canvas) {
            float w = getWidth(), h = getHeight(), r = h / 2f;
            paint.setColor(checked ? onColor : offColor);
            canvas.drawRoundRect(0f, 0f, w, h, r, r, paint);
            float pad = h * 0.14f, tr = (h - 2f * pad) / 2f;
            float cx = checked ? (w - pad - tr) : (pad + tr);
            paint.setColor(thumbColor);
            canvas.drawCircle(cx, h / 2f, tr, paint);
        }

        // Present as a checkable Switch to TalkBack so screen-reader users still get
        // the control's role + on/off state (the platform Switch gave this for free).
        @Override
        public void onInitializeAccessibilityNodeInfo(android.view.accessibility.AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(info);
            info.setClassName("android.widget.Switch");
            info.setCheckable(true);
            info.setChecked(checked);
        }
    }

    /**
     * The row is the single semantic switch and owns the full 48 dp+ hit target.
     * The painted thumb remains visual-only so TalkBack never stops on both the
     * row and the child for one setting.
     */
    private void configureToggleRow(
            final LinearLayout row,
            final Toggle toggle,
            final String label,
            final String description) {
        row.setClickable(true);
        row.setFocusable(true);
        row.setMinimumHeight(dp(64));
        row.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
        row.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        toggle.setClickable(false);
        toggle.setFocusable(false);
        toggle.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override
            public void onInitializeAccessibilityNodeInfo(
                    View host,
                    android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName("android.widget.Switch");
                info.setCheckable(true);
                info.setChecked(toggle.isChecked());
                info.setText(label);
                info.setContentDescription(getString(
                        R.string.downloads_toggle_description, label, description));
                if (Build.VERSION.SDK_INT >= 30) {
                    info.setStateDescription(getString(toggle.isChecked()
                            ? R.string.downloads_state_on
                            : R.string.downloads_state_off));
                }
                info.addAction(new android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(
                        android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK,
                        getString(toggle.isChecked()
                                ? R.string.downloads_turn_off
                                : R.string.downloads_turn_on, label)));
            }
        });
        syncToggleAccessibility(row, toggle, label, description);
    }

    private void syncToggleAccessibility(
            LinearLayout row,
            Toggle toggle,
            String label,
            String description) {
        String state = getString(toggle.isChecked()
                ? R.string.downloads_state_on
                : R.string.downloads_state_off);
        row.setContentDescription(Build.VERSION.SDK_INT >= 30
                ? getString(R.string.downloads_toggle_description, label, description)
                : getString(R.string.downloads_toggle_description_with_state,
                        label, description, state));
        if (Build.VERSION.SDK_INT >= 30) row.setStateDescription(state);
        row.invalidate();
        row.sendAccessibilityEvent(
                android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    @Override
    protected void onResume() {
        super.onResume();
        lifecycleActive = true;
        lifecycleGeneration++;
        requestRefresh(true);
        handler.removeCallbacks(poll);
        handler.postDelayed(poll, 1500L);
    }

    @Override
    protected void onPause() {
        lifecycleActive = false;
        lifecycleGeneration++;
        handler.removeCallbacks(poll);
        synchronized (refreshLock) {
            refreshTaskToken++;
            if (refreshFuture != null) refreshFuture.cancel(true);
            refreshFuture = null;
            refreshInFlight = false;
            refreshQueued = false;
            forceQueuedRefresh = false;
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        lifecycleActive = false;
        handler.removeCallbacksAndMessages(null);
        refreshExecutor.shutdownNow();
        // User-requested writes are allowed to finish; their UI callback is
        // lifecycle-guarded and cannot repaint this destroyed Activity.
        mutationExecutor.shutdown();
        synchronized (posterCache) {
            posterCache.evictAll();
        }
        super.onDestroy();
    }

    // ---- Rendering ----

    private void renderNow() {
        requestRefresh(true);
    }

    /**
     * Coalesces the 1.5 second poll into one background manifest read at a time.
     * A forced request never starts a second read; it schedules one follow-up
     * pass so user actions cannot create a refresh stampede.
     */
    private void requestRefresh(boolean force) {
        if (!lifecycleActive || refreshExecutor.isShutdown()) return;

        final long taskToken;
        final long sequence;
        final long lifecycle;
        final long mutation;
        synchronized (refreshLock) {
            if (pendingMutationCount > 0) {
                refreshQueued = true;
                forceQueuedRefresh |= force;
                return;
            }
            if (refreshInFlight) {
                refreshQueued = true;
                forceQueuedRefresh |= force;
                return;
            }
            refreshInFlight = true;
            taskToken = ++refreshTaskToken;
            sequence = ++issuedRefreshSequence;
            lifecycle = lifecycleGeneration;
            mutation = mutationGeneration;
            refreshFuture = refreshExecutor.submit(() -> {
                Snapshot snapshot = null;
                Throwable failure = null;
                try {
                    snapshot = loadSnapshot(sequence, lifecycle, mutation, force);
                } catch (Throwable error) {
                    failure = error;
                }
                final Snapshot result = snapshot;
                final Throwable refreshFailure = failure;
                handler.post(() -> finishRefresh(taskToken, result, refreshFailure));
            });
        }
    }

    private Snapshot loadSnapshot(
            long sequence,
            long lifecycle,
            long mutation,
            boolean force) {
        List<DownloadStore.Item> items =
                new ArrayList<>(DownloadStore.all(getApplicationContext()));
        boolean wifiWait = DownloadService.getWifiOnly(getApplicationContext()) && !onWifiNow();
        long used = usedBytes();
        long free = freeBytes();
        Map<String, Bitmap> posters = new LinkedHashMap<>();
        Map<String, String> posterKeys = new LinkedHashMap<>();
        int targetPx = dp(164);

        for (DownloadStore.Item item : items) {
            if (Thread.currentThread().isInterrupted()) {
                throw new IllegalStateException("refresh cancelled");
            }
            String path = posterPathFor(item);
            String key = posterCacheKey(path);
            if (key.isEmpty()) {
                posterKeys.put(item.id, "");
                continue;
            }
            Bitmap bitmap;
            synchronized (posterCache) {
                bitmap = posterCache.get(key);
            }
            if (bitmap == null) {
                bitmap = decodePoster(path, targetPx);
                if (bitmap != null) {
                    synchronized (posterCache) {
                        posterCache.put(key, bitmap);
                    }
                }
            }
            posterKeys.put(item.id, bitmap == null ? "decode-missing:" + key : key);
            if (bitmap != null) posters.put(item.id, bitmap);
        }

        String structure = structureSignature(items, wifiWait, posterKeys);
        String content = contentSignature(items, structure, used, free);
        return new Snapshot(
                sequence,
                lifecycle,
                mutation,
                force,
                items,
                posters,
                structure,
                content,
                used,
                free,
                wifiWait);
    }

    private void finishRefresh(long taskToken, Snapshot snapshot, Throwable failure) {
        boolean runAgain;
        boolean forceAgain;
        synchronized (refreshLock) {
            if (taskToken != refreshTaskToken) return;
            refreshFuture = null;
            refreshInFlight = false;
            runAgain = refreshQueued;
            forceAgain = forceQueuedRefresh;
            refreshQueued = false;
            forceQueuedRefresh = false;
        }

        if (lifecycleActive) {
            if (failure == null && snapshot != null) {
                commitSnapshot(snapshot);
            } else if (!(failure instanceof IllegalStateException
                    && "refresh cancelled".equals(failure.getMessage()))) {
                showRefreshFailure();
            }
            if (runAgain) requestRefresh(forceAgain);
        }
    }

    /**
     * Only the newest snapshot for the current Activity and mutation generation
     * may reach views. This prevents a completed pre-action read from repainting
     * deleted or re-ordered downloads.
     */
    private void commitSnapshot(Snapshot snapshot) {
        if (!lifecycleActive
                || snapshot.lifecycleGeneration != lifecycleGeneration
                || snapshot.mutationGeneration != mutationGeneration
                || snapshot.sequence <= committedRefreshSequence) {
            return;
        }
        committedRefreshSequence = snapshot.sequence;

        Snapshot previous = currentSnapshot;
        boolean structureChanged = snapshot.force
                || !snapshot.structureSignature.equals(lastStructureSignature);
        boolean contentChanged = structureChanged
                || !snapshot.contentSignature.equals(lastContentSignature);
        currentSnapshot = snapshot;
        if (!contentChanged) return;

        lastStructureSignature = snapshot.structureSignature;
        lastContentSignature = snapshot.contentSignature;
        if (structureChanged) renderStructure(snapshot);
        renderHeader(snapshot);
        updateStatusViews(snapshot.items);
        announceSnapshotChanges(previous, snapshot);
    }

    private static String structureSignature(
            List<DownloadStore.Item> items,
            boolean wifiWait,
            Map<String, String> posterKeys) {
        StringBuilder out = new StringBuilder(wifiWait ? "wifi-wait;" : "network-ready;");
        for (DownloadStore.Item item : items) {
            appendSignature(out, item.id);
            appendSignature(out, item.itemType);
            appendSignature(out, item.title);
            appendSignature(out, item.subtitle);
            appendSignature(out, item.episodeTitle);
            appendSignature(out, item.state);
            appendSignature(out, item.allowCellular ? "cellular" : "wifi");
            appendSignature(out, item.url == null || item.url.isEmpty() ? "no-retry" : "retry");
            appendSignature(out, String.valueOf(item.season));
            appendSignature(out, String.valueOf(item.episodeNum));
            appendSignature(out, String.valueOf(item.queueOrder));
            appendSignature(out, posterKeys.get(item.id));
        }
        return out.toString();
    }

    private static String contentSignature(
            List<DownloadStore.Item> items,
            String structure,
            long used,
            long free) {
        StringBuilder out = new StringBuilder(structure);
        appendSignature(out, String.valueOf(used));
        appendSignature(out, String.valueOf(free));
        for (DownloadStore.Item item : items) {
            appendSignature(out, item.id);
            appendSignature(out, String.valueOf(item.downloadedBytes));
            appendSignature(out, String.valueOf(item.totalBytes));
            appendSignature(out, item.error);
            appendSignature(out, String.valueOf(item.positionSeconds));
        }
        return out.toString();
    }

    private static void appendSignature(StringBuilder out, String value) {
        String safe = value == null ? "" : value;
        out.append(safe.length()).append(':').append(safe).append(';');
    }

    private String posterCacheKey(String path) {
        if (path == null || path.isEmpty()) return "";
        File file = new File(path);
        if (!file.isFile()) return "";
        return path + "|" + file.lastModified() + "|" + file.length();
    }

    private static Bitmap decodePoster(String path, int targetPx) {
        if (path == null || path.isEmpty()) return null;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            int sample = 1;
            int largest = Math.max(bounds.outWidth, bounds.outHeight);
            while (largest > targetPx * 2 && sample < 16) {
                sample *= 2;
                largest /= 2;
            }
            BitmapFactory.Options decode = new BitmapFactory.Options();
            decode.inSampleSize = sample;
            decode.inPreferredConfig = Bitmap.Config.RGB_565;
            return BitmapFactory.decodeFile(path, decode);
        } catch (RuntimeException | OutOfMemoryError ignored) {
            return null;
        }
    }

    private static final class Snapshot {
        final long sequence;
        final long lifecycleGeneration;
        final long mutationGeneration;
        final boolean force;
        final List<DownloadStore.Item> items;
        final Map<String, Bitmap> posters;
        final String structureSignature;
        final String contentSignature;
        final long usedBytes;
        final long freeBytes;
        final boolean wifiWait;

        Snapshot(
                long sequence,
                long lifecycleGeneration,
                long mutationGeneration,
                boolean force,
                List<DownloadStore.Item> items,
                Map<String, Bitmap> posters,
                String structureSignature,
                String contentSignature,
                long usedBytes,
                long freeBytes,
                boolean wifiWait) {
            this.sequence = sequence;
            this.lifecycleGeneration = lifecycleGeneration;
            this.mutationGeneration = mutationGeneration;
            this.force = force;
            this.items = Collections.unmodifiableList(new ArrayList<>(items));
            this.posters = Collections.unmodifiableMap(new LinkedHashMap<>(posters));
            this.structureSignature = structureSignature;
            this.contentSignature = contentSignature;
            this.usedBytes = usedBytes;
            this.freeBytes = freeBytes;
            this.wifiWait = wifiWait;
        }
    }

    private void renderStructure(Snapshot snapshot) {
        List<DownloadStore.Item> items = snapshot.items;
        statusViews.clear();
        list.removeAllViews();

        // Movies as cards; episodes grouped under their show (preserve order).
        Map<String, List<DownloadStore.Item>> shows = new LinkedHashMap<>();
        for (DownloadStore.Item it : items) {
            if ("episode".equals(it.itemType)) {
                String key = it.title == null ? "" : it.title;
                List<DownloadStore.Item> g = shows.get(key);
                if (g == null) { g = new ArrayList<>(); shows.put(key, g); }
                g.add(it);
            } else {
                list.addView(movieCard(it));
            }
        }
        for (Map.Entry<String, List<DownloadStore.Item>> e : shows.entrySet()) {
            list.addView(showCard(e.getKey(), e.getValue()));
        }
    }

    /** Lightweight bindings updated on every changed snapshot without rebuilding cards. */
    private void renderHeader(Snapshot snapshot) {
        List<DownloadStore.Item> items = snapshot.items;
        empty.setVisibility(items.isEmpty() ? View.VISIBLE : View.GONE);
        setClearAllEnabled(!items.isEmpty());

        int done = 0;
        int remaining = 0;
        String activeTitle = null;
        int activePct = 0;
        for (DownloadStore.Item item : items) {
            if ("done".equals(item.state)) done++;
            else remaining++;
            if ("downloading".equals(item.state)) {
                activeTitle = displayTitle(item);
                activePct = item.totalBytes > 0
                        ? (int) Math.min(100, item.downloadedBytes * 100 / item.totalBytes)
                        : 0;
            }
        }

        summary.setText(items.isEmpty() ? ""
                : getResources().getQuantityString(
                        R.plurals.downloads_summary_titles,
                        done,
                        done,
                        sizeStr(snapshot.usedBytes),
                        sizeStr(snapshot.freeBytes)));
        if (activeTitle != null) {
            active.setVisibility(View.VISIBLE);
            active.setText(remaining > 1
                    ? getResources().getQuantityString(
                            R.plurals.downloads_active_with_queue,
                            remaining - 1,
                            activeTitle,
                            activePct,
                            remaining - 1)
                    : getString(R.string.downloads_active, activeTitle, activePct));
        } else if (remaining > 0) {
            active.setVisibility(View.VISIBLE);
            String queue = getResources().getQuantityString(
                    R.plurals.downloads_in_queue, remaining, remaining);
            active.setText(snapshot.wifiWait
                    ? getString(R.string.downloads_queue_waiting_wifi, queue)
                    : queue);
        } else {
            active.setVisibility(View.GONE);
        }
    }

    private void updateStatusViews(List<DownloadStore.Item> items) {
        for (DownloadStore.Item item : items) {
            TextView status = statusViews.get(item.id);
            if (status != null) bindStatus(status, item);
        }
    }

    private void showRefreshFailure() {
        active.setVisibility(View.VISIBLE);
        String message = getString(R.string.downloads_refresh_failed);
        active.setText(message);
        announceStatus(message);
    }

    private void announceStatus(String message) {
        if (summary != null) summary.announceForAccessibility(message);
    }

    private void announceSnapshotChanges(Snapshot previous, Snapshot next) {
        Set<String> liveIds = new HashSet<>();
        Map<String, DownloadStore.Item> oldById = new LinkedHashMap<>();
        if (previous != null) {
            for (DownloadStore.Item item : previous.items) oldById.put(item.id, item);
        }

        for (DownloadStore.Item item : next.items) {
            liveIds.add(item.id);
            DownloadStore.Item old = oldById.get(item.id);
            if ("downloading".equals(item.state)) {
                int pct = item.totalBytes > 0
                        ? (int) Math.min(100, item.downloadedBytes * 100 / item.totalBytes)
                        : 0;
                int bucket = pct / 10;
                Integer priorBucket = announcedProgressBuckets.put(item.id, bucket);
                if (previous != null && bucket > 0
                        && (priorBucket == null || bucket > priorBucket)) {
                    int announcedPercent = bucket * 10;
                    announceStatus(getResources().getQuantityString(
                            R.plurals.downloads_a11y_progress,
                            announcedPercent,
                            displayTitle(item),
                            announcedPercent));
                }
            } else {
                announcedProgressBuckets.remove(item.id);
            }

            if ("done".equals(item.state)
                    && old != null
                    && !"done".equals(old.state)) {
                announceStatus(getString(
                        R.string.downloads_a11y_ready_offline, displayTitle(item)));
            }

            if ("failed".equals(item.state)) {
                if (old != null
                        && !"failed".equals(old.state)
                        && announcedFailures.add(item.id)) {
                    announceStatus(getString(
                            R.string.downloads_a11y_failed, displayTitle(item)));
                }
            } else {
                announcedFailures.remove(item.id);
            }
        }
        announcedProgressBuckets.keySet().retainAll(liveIds);
        announcedFailures.retainAll(liveIds);
    }

    private String displayTitle(DownloadStore.Item item) {
        return item.title == null || item.title.trim().isEmpty()
                ? getString(R.string.downloads_fallback_title)
                : item.title.trim();
    }

    // ---- Movie card ----

    private View movieCard(final DownloadStore.Item it) {
        LinearLayout card = card();
        card.setOrientation(LinearLayout.VERTICAL);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(posterView(it, 56, 82));

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        mid.addView(titleText(it.title));
        mid.addView(statusText(it));
        top.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        card.addView(top);

        // Actions go on their own full-width row (see actionsRow) so a long set
        // — Mobile data · ▲ · ▼ · Cancel on a queued item — never clips beside the
        // title on a narrow phone.
        card.addView(actionsRow(it));
        return card;
    }

    // ---- Show (series) group card ----

    private View showCard(String showTitle, List<DownloadStore.Item> episodes) {
        LinearLayout card = card();
        card.setOrientation(LinearLayout.VERTICAL);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.addView(posterView(episodes.get(0), 48, 70));
        LinearLayout headMid = new LinearLayout(this);
        headMid.setOrientation(LinearLayout.VERTICAL);
        headMid.addView(titleText(showTitle));
        TextView count = new TextView(this);
        count.setText(getResources().getQuantityString(
                R.plurals.downloads_episode_count, episodes.size(), episodes.size()));
        count.setTextColor(MUTED);
        count.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        count.setPadding(0, dp(3), 0, 0);
        headMid.addView(count);
        head.addView(headMid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        card.addView(head);

        // Group the show's episodes by season (ascending; unknown season last),
        // each under a collapsible header, sorted by episode number within.
        Map<Integer, List<DownloadStore.Item>> bySeason = new TreeMap<>((a, b) -> {
            if (a.intValue() == b.intValue()) return 0;
            if (a <= 0) return 1;
            if (b <= 0) return -1;
            return Integer.compare(a, b);
        });
        for (DownloadStore.Item ep : episodes) {
            int s = seasonOf(ep);
            List<DownloadStore.Item> g = bySeason.get(s);
            if (g == null) { g = new ArrayList<>(); bySeason.put(s, g); }
            g.add(ep);
        }

        for (Map.Entry<Integer, List<DownloadStore.Item>> se : bySeason.entrySet()) {
            final int season = se.getKey();
            List<DownloadStore.Item> eps = se.getValue();
            Collections.sort(eps, (a, b) -> {
                int c = Integer.compare(episodeOf(a), episodeOf(b));
                return c != 0 ? c : Long.compare(a.createdAt, b.createdAt);
            });

            final String key = showTitle + "|" + season;
            final LinearLayout body = new LinearLayout(this);
            body.setOrientation(LinearLayout.VERTICAL);
            body.setVisibility(collapsed.contains(key) ? View.GONE : View.VISIBLE);
            for (DownloadStore.Item ep : eps) body.addView(episodeRow(ep));

            card.addView(seasonHeader(season, eps.size(), key, body));
            card.addView(body);
        }
        return card;
    }

    /** A collapsible "Season N" header; tapping toggles {@code body} and remembers it. */
    private LinearLayout seasonHeader(int season, int count, final String key, final LinearLayout body) {
        LinearLayout h = new LinearLayout(this);
        h.setOrientation(LinearLayout.HORIZONTAL);
        h.setGravity(Gravity.CENTER_VERTICAL);
        h.setPadding(0, dp(13), 0, dp(2));
        h.setClickable(true);
        h.setFocusable(true);
        h.setMinimumHeight(dp(48));
        h.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);

        final TextView chevron = new TextView(this);
        chevron.setText(collapsed.contains(key) ? "▸" : "▾");
        chevron.setTextColor(MUTED);
        chevron.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.rightMargin = dp(8);
        chevron.setLayoutParams(clp);
        chevron.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        h.addView(chevron);

        TextView label = new TextView(this);
        final String semanticLabel = season > 0
                ? getString(R.string.downloads_season_number, season)
                : getString(R.string.downloads_episodes);
        label.setText(semanticLabel);
        label.setTextColor(TEXT);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        h.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView c = new TextView(this);
        c.setText(getResources().getQuantityString(
                R.plurals.downloads_episode_count, count, count));
        c.setTextColor(MUTED);
        c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        c.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        h.addView(c);
        syncSeasonHeaderAccessibility(h, semanticLabel, count, collapsed.contains(key));

        h.setOnClickListener(v -> {
            if (collapsed.contains(key)) {
                collapsed.remove(key);
                body.setVisibility(View.VISIBLE);
                chevron.setText("▾");
                syncSeasonHeaderAccessibility(h, semanticLabel, count, false);
                h.announceForAccessibility(getString(
                        R.string.downloads_section_expanded, semanticLabel));
            } else {
                collapsed.add(key);
                body.setVisibility(View.GONE);
                chevron.setText("▸");
                syncSeasonHeaderAccessibility(h, semanticLabel, count, true);
                h.announceForAccessibility(getString(
                        R.string.downloads_section_collapsed, semanticLabel));
            }
        });
        return h;
    }

    private void syncSeasonHeaderAccessibility(
            LinearLayout header,
            String label,
            int count,
            boolean isCollapsed) {
        String state = getString(isCollapsed
                ? R.string.downloads_state_collapsed
                : R.string.downloads_state_expanded);
        String episodeCount = getResources().getQuantityString(
                R.plurals.downloads_episode_count, count, count);
        header.setContentDescription(getString(
                R.string.downloads_section_description,
                label,
                episodeCount,
                state,
                getString(isCollapsed
                        ? R.string.downloads_expand
                        : R.string.downloads_collapse)));
        if (Build.VERSION.SDK_INT >= 30) header.setStateDescription(state);
    }

    /** One episode row inside a season group. */
    private View episodeRow(final DownloadStore.Item ep) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(10), 0, 0);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        TextView label = new TextView(this);
        label.setText(episodeLabel(ep));
        label.setTextColor(TEXT);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        label.setMaxLines(1);
        mid.addView(label);
        mid.addView(statusText(ep));
        row.addView(mid);

        row.addView(actionsRow(ep));
        return row;
    }

    // ---- Season / episode parsing ----

    private int seasonOf(DownloadStore.Item it) {
        return it.season > 0 ? it.season : parseSE(it.subtitle)[0];
    }

    private int episodeOf(DownloadStore.Item it) {
        return it.episodeNum > 0 ? it.episodeNum : parseSE(it.subtitle)[1];
    }

    /** Best-effort {season, episode} from a "S1E2 · Title" style subtitle (0 when absent). */
    private static int[] parseSE(String s) {
        if (s != null) {
            Matcher m = SXEY.matcher(s);
            if (m.find()) {
                try {
                    return new int[]{ Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)) };
                } catch (NumberFormatException ignored) { }
            }
        }
        return new int[]{0, 0};
    }

    private String episodeLabel(DownloadStore.Item ep) {
        String title = ep.episodeTitle != null && !ep.episodeTitle.isEmpty()
                ? ep.episodeTitle : stripSEPrefix(ep.subtitle);
        int e = episodeOf(ep);
        if (e > 0) {
            return title.isEmpty()
                    ? getString(R.string.downloads_episode_number, e)
                    : getString(R.string.downloads_episode_short_title, e, title);
        }
        return title.isEmpty() ? getString(R.string.downloads_episode) : title;
    }

    /** Drop a leading "S1E2 ·" / "S1 E2 -" marker so the row shows just the title. */
    private static String stripSEPrefix(String s) {
        if (s == null) return "";
        return s.replaceFirst("(?i)^\\s*S\\d{1,3}\\s*E\\d{1,4}\\s*[·:\\-–—|]*\\s*", "").trim();
    }

    /** Add the control pills valid for this item's state into {@code actions}. */
    /** Actions on their own full-width, horizontally-scrollable row, so a long set
     *  of buttons never clips on a narrow phone instead of fitting beside the title. */
    private HorizontalScrollView actionsRow(final DownloadStore.Item it) {
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(8), 0, 0);
        addActions(actions, it);
        HorizontalScrollView sv = new HorizontalScrollView(this);
        sv.setHorizontalScrollBarEnabled(false);
        sv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        sv.setFocusable(false);
        sv.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        sv.addView(actions, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return sv;
    }

    private void addActions(LinearLayout actions, final DownloadStore.Item it) {
        String play = getString(R.string.downloads_action_play);
        String delete = getString(R.string.downloads_action_delete);
        String cancel = getString(R.string.downloads_action_cancel);
        switch (it.state) {
            case "done":
                actions.addView(actionPill(play, play, ACCENT, TEXT, it, v -> playLocal(it)));
                actions.addView(actionPill(
                        delete, delete, SUBTLE, MUTED, it, v -> confirmDelete(it)));
                break;
            case "downloading":
                String pause = getString(R.string.downloads_action_pause);
                actions.addView(actionPill(pause, pause, SUBTLE, TEXT, it,
                        v -> executeMutation(
                                R.string.downloads_mutation_paused,
                                () -> DownloadService.requestPause(
                                        getApplicationContext(), it.id))));
                actions.addView(actionPill(
                        cancel, cancel, SUBTLE, MUTED, it, v -> confirmDelete(it)));
                break;
            case "paused":
                String resume = getString(R.string.downloads_action_resume);
                actions.addView(actionPill(resume, resume, ACCENT, TEXT, it,
                        v -> executeMutation(
                                R.string.downloads_mutation_resumed,
                                () -> DownloadService.requestResume(
                                        getApplicationContext(), it.id))));
                actions.addView(actionPill(
                        cancel, cancel, SUBTLE, MUTED, it, v -> confirmDelete(it)));
                break;
            case "queued":
                if (currentSnapshot != null && currentSnapshot.wifiWait && !it.allowCellular) {
                    actions.addView(actionPill(
                            getString(R.string.downloads_action_mobile_data),
                            getString(R.string.downloads_action_allow_mobile_data),
                            ACCENT,
                            TEXT,
                            it,
                            v -> executeMutation(
                                    R.string.downloads_mutation_mobile_data_allowed,
                                    () -> DownloadService.setAllowCellular(
                                            getApplicationContext(), it.id, true))));
                }
                actions.addView(actionPill(
                        "\u25b2",
                        getString(R.string.downloads_action_move_earlier),
                        SUBTLE,
                        TEXT,
                        it,
                        v -> executeMutation(
                                R.string.downloads_mutation_moved_earlier,
                                () -> DownloadService.moveInQueue(
                                        getApplicationContext(), it.id, -1))));
                actions.addView(actionPill(
                        "\u25bc",
                        getString(R.string.downloads_action_move_later),
                        SUBTLE,
                        TEXT,
                        it,
                        v -> executeMutation(
                                R.string.downloads_mutation_moved_later,
                                () -> DownloadService.moveInQueue(
                                        getApplicationContext(), it.id, 1))));
                actions.addView(actionPill(
                        cancel, cancel, SUBTLE, MUTED, it, v -> confirmDelete(it)));
                break;
            case "failed":
                if (it.url != null && !it.url.isEmpty()) {
                    String retry = getString(R.string.downloads_action_retry);
                    actions.addView(actionPill(retry, retry, ACCENT, TEXT, it,
                            v -> executeMutation(
                                    R.string.downloads_mutation_retry_queued,
                                    () -> DownloadService.requestResume(
                                            getApplicationContext(), it.id))));
                }
                actions.addView(actionPill(
                        delete, delete, SUBTLE, MUTED, it, v -> confirmDelete(it)));
                break;
            default:
                actions.addView(actionPill(
                        delete, delete, SUBTLE, MUTED, it, v -> confirmDelete(it)));
        }
    }

    private TextView actionPill(
            String visualLabel,
            String actionLabel,
            int background,
            int textColor,
            DownloadStore.Item item,
            View.OnClickListener listener) {
        TextView button = pillSpaced(visualLabel, background, textColor, listener);
        button.setContentDescription(getString(
                R.string.downloads_action_for_title, actionLabel, displayTitle(item)));
        return button;
    }

    private TextView statusText(DownloadStore.Item it) {
        TextView s = new TextView(this);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        s.setPadding(0, dp(4), 0, 0);
        bindStatus(s, it);
        if (it.id != null) statusViews.put(it.id, s);
        return s;
    }

    private void bindStatus(TextView s, DownloadStore.Item it) {
        s.setTextColor("failed".equals(it.state) ? DANGER : MUTED);
        switch (it.state) {
            case "done":
                s.setText(getString(
                        R.string.downloads_status_saved, sizeStr(it.totalBytes)));
                break;
            case "downloading": {
                int pct = it.totalBytes > 0 ? (int) (it.downloadedBytes * 100 / it.totalBytes) : 0;
                s.setText(it.totalBytes > 0
                        ? getString(
                                R.string.downloads_status_downloading_progress,
                                pct,
                                sizeStr(it.downloadedBytes),
                                sizeStr(it.totalBytes))
                        : getString(R.string.downloads_status_downloading));
                break;
            }
            case "paused":
                s.setText(it.totalBytes > 0
                        ? getString(
                                R.string.downloads_status_paused_progress,
                                sizeStr(it.downloadedBytes),
                                sizeStr(it.totalBytes))
                        : getString(
                                R.string.downloads_status_paused, sizeStr(it.downloadedBytes)));
                break;
            case "queued":
                s.setText(R.string.downloads_status_queued);
                break;
            case "failed":
                // Provider/network details may contain credentials or implementation data.
                s.setText(R.string.downloads_status_failed);
                break;
            default:
                s.setText(R.string.downloads_status_unavailable);
        }
    }

    // ---- Actions ----

    private void executeMutation(int successMessageRes, Runnable work) {
        if (mutationExecutor.isShutdown()) return;
        final long mutation = ++mutationGeneration;
        final long lifecycle = lifecycleGeneration;
        synchronized (refreshLock) {
            pendingMutationCount++;
            refreshTaskToken++;
            if (refreshFuture != null) refreshFuture.cancel(true);
            refreshFuture = null;
            refreshInFlight = false;
            refreshQueued = true;
            forceQueuedRefresh = true;
        }
        mutationExecutor.execute(() -> {
            Throwable failure = null;
            try {
                work.run();
            } catch (Throwable error) {
                failure = error;
            }
            final Throwable mutationFailure = failure;
            handler.post(() -> {
                boolean refreshAfterMutation;
                synchronized (refreshLock) {
                    pendingMutationCount = Math.max(0, pendingMutationCount - 1);
                    refreshAfterMutation = pendingMutationCount == 0;
                    if (refreshAfterMutation) {
                        refreshQueued = false;
                        forceQueuedRefresh = false;
                    }
                }
                if (lifecycleActive
                        && lifecycle == lifecycleGeneration
                        && mutation == mutationGeneration) {
                    if (mutationFailure == null) {
                        String successMessage = getString(successMessageRes);
                        Toast.makeText(this, successMessage, Toast.LENGTH_SHORT).show();
                        announceStatus(successMessage);
                    } else {
                        String safeError = getString(R.string.downloads_mutation_failed);
                        Toast.makeText(this, safeError, Toast.LENGTH_SHORT).show();
                        announceStatus(safeError);
                    }
                }
                if (refreshAfterMutation && lifecycleActive) requestRefresh(true);
            });
        });
    }

    private void playLocal(DownloadStore.Item it) {
        File f = new File(it.filePath);
        if (!f.exists()) {
            String message = getString(R.string.downloads_file_unavailable);
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
            announceStatus(message);
            return;
        }
        Intent i = new Intent(this, PlayerActivity.class);
        i.putExtra(PlayerActivity.EXTRA_URL, Uri.fromFile(f).toString());
        i.putExtra(PlayerActivity.EXTRA_TITLE, it.subtitle != null && !it.subtitle.isEmpty()
                ? getString(R.string.downloads_title_with_subtitle, it.title, it.subtitle)
                : it.title);
        i.putExtra(PlayerActivity.EXTRA_LOCAL, true);
        i.putExtra(PlayerActivity.EXTRA_WRAPPED_KEY, it.wrappedKey);
        i.putExtra(PlayerActivity.EXTRA_KEY_IV, it.keyIv);
        i.putExtra(PlayerActivity.EXTRA_MEDIA_IV, it.mediaIv);
        i.putExtra(PlayerActivity.EXTRA_CONTAINER, it.container);
        i.putExtra(PlayerActivity.EXTRA_SOURCE_ID, it.sourceId);
        i.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, it.itemType);
        i.putExtra(PlayerActivity.EXTRA_ITEM_ID, it.itemId);
        if (it.positionSeconds > 0) i.putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, it.positionSeconds);
        startActivity(i);
    }

    private void confirmDelete(final DownloadStore.Item it) {
        boolean finished = "done".equals(it.state) || "failed".equals(it.state);
        String label = it.subtitle != null && !it.subtitle.isEmpty()
                ? getString(R.string.downloads_title_with_subtitle, it.title, it.subtitle)
                : it.title;
        styledConfirm(
                getString(finished
                        ? R.string.downloads_confirm_delete_title
                        : R.string.downloads_confirm_cancel_title),
                getString(finished
                        ? R.string.downloads_confirm_delete_message
                        : R.string.downloads_confirm_cancel_message, label),
                getString(finished
                        ? R.string.downloads_action_delete
                        : R.string.downloads_action_cancel_download),
                () -> executeMutation(
                        R.string.downloads_mutation_removal_requested,
                        () -> DownloadService.requestCancel(
                                getApplicationContext(), it.id)));
    }

    private void confirmClearAll() {
        Snapshot snapshot = currentSnapshot;
        List<DownloadStore.Item> items = snapshot == null
                ? Collections.emptyList()
                : snapshot.items;
        if (items.isEmpty()) return;
        List<String> ids = new ArrayList<>();
        for (DownloadStore.Item item : items) ids.add(item.id);
        styledConfirm(
                getString(R.string.downloads_confirm_delete_all_title),
                getResources().getQuantityString(
                        R.plurals.downloads_confirm_delete_all_message,
                        items.size(),
                        items.size()),
                getString(R.string.downloads_action_delete_all),
                () -> executeMutation(R.string.downloads_mutation_removing_all, () -> {
                    for (String id : ids) {
                        DownloadService.requestCancel(getApplicationContext(), id);
                    }
                }));
    }

    /** A confirmation dialog styled to match the app (dark card, danger action). */
    private void styledConfirm(String title, String message, String confirmLabel, final Runnable onConfirm) {
        final Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout cardView = new LinearLayout(this);
        cardView.setOrientation(LinearLayout.VERTICAL);
        cardView.setBackground(roundedStroke(CARD, CARD_BORDER, 18));
        cardView.setPadding(dp(22), dp(22), dp(22), dp(16));

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(TEXT);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        if (Build.VERSION.SDK_INT >= 28) titleView.setAccessibilityHeading(true);
        cardView.addView(titleView);

        TextView messageView = new TextView(this);
        messageView.setText(message);
        messageView.setTextColor(MUTED);
        messageView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        messageView.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mlp.topMargin = dp(12);
        messageView.setLayoutParams(mlp);
        cardView.addView(messageView);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        alp.topMargin = dp(20);
        actions.setLayoutParams(alp);

        TextView keep = pill(getString(R.string.downloads_action_keep), SUBTLE, TEXT);
        keep.setContentDescription(getString(R.string.downloads_action_keep_description));
        keep.setOnClickListener(v -> dialog.dismiss());
        actions.addView(keep);

        TextView confirm = pillSpaced(confirmLabel, DANGER, TEXT, v -> {
            dialog.dismiss();
            if (onConfirm != null) onConfirm.run();
        });
        confirm.setContentDescription(confirmLabel);
        actions.addView(confirm);

        cardView.addView(actions);

        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(dp(24), 0, dp(24), 0);
        wrap.addView(cardView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        dialog.setContentView(wrap);
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(0x00000000));
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        }
        keep.requestFocus();
    }

    // ---- Storage ----

    private long usedBytes() {
        long sum = 0;
        File[] files = downloadsDir().listFiles();
        if (files != null) for (File f : files) sum += f.length();
        return sum;
    }

    private long freeBytes() {
        try {
            return storageBase().getUsableSpace();
        } catch (Exception e) {
            return 0;
        }
    }

    private File storageBase() {
        File base = getExternalFilesDir(null);
        return base != null ? base : getFilesDir();
    }

    private File downloadsDir() {
        return new File(storageBase(), "downloads");
    }

    private boolean onWifiNow() {
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            android.net.Network n = cm.getActiveNetwork();
            if (n == null) return false;
            android.net.NetworkCapabilities c = cm.getNetworkCapabilities(n);
            return c != null && (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    || c.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
        } catch (Exception e) {
            return true;
        }
    }

    // ---- Views / styling ----

    private void setClearAllEnabled(boolean enabled) {
        if (clearAll == null) return;
        clearAll.setEnabled(enabled);
        clearAll.setClickable(enabled);
        clearAll.setFocusable(enabled);
        clearAll.setAlpha(enabled ? 1f : 0.45f);
        clearAll.setContentDescription(enabled
                ? getString(R.string.downloads_clear_all_description)
                : getString(R.string.downloads_clear_all_disabled_description));
    }

    private TextView titleText(String text) {
        TextView t = new TextView(this);
        t.setText(text == null ? "" : text);
        t.setTextColor(TEXT);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setMaxLines(2);
        return t;
    }

    private ImageView posterView(DownloadStore.Item it, int wDp, int hDp) {
        ImageView poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setBackground(rounded(Color.parseColor("#1d1d27"), 10));
        roundCorners(poster, dp(10));
        Bitmap bitmap = currentSnapshot == null ? null : currentSnapshot.posters.get(it.id);
        if (bitmap != null) poster.setImageBitmap(bitmap);
        poster.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(wDp), dp(hDp));
        lp.rightMargin = dp(13);
        poster.setLayoutParams(lp);
        return poster;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(this);
        card.setBackground(roundedStroke(CARD, CARD_BORDER, 14));
        card.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(12);
        card.setLayoutParams(lp);
        return card;
    }

    private TextView pillSpaced(String text, int bg, int textColor, View.OnClickListener cb) {
        TextView b = pill(text, bg, textColor);
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) b.getLayoutParams();
        lp.leftMargin = dp(8);
        b.setLayoutParams(lp);
        b.setOnClickListener(cb);
        return b;
    }

    private TextView pill(String text, int bg, int textColor) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setTextColor(textColor);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(15), dp(9), dp(15), dp(9));
        b.setMinimumWidth(dp(48));
        b.setMinimumHeight(dp(48));
        b.setBackground(rounded(bg, 10));
        b.setClickable(true);
        b.setFocusable(true);
        b.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return b;
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    private GradientDrawable roundedStroke(int fill, int stroke, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radiusDp));
        d.setStroke(Math.max(1, dp(1)), stroke);
        return d;
    }

    private void roundCorners(View v, final int radiusPx) {
        v.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), radiusPx);
            }
        });
        v.setClipToOutline(true);
    }

    private String posterPathFor(DownloadStore.Item it) {
        if (it.posterFile != null && !it.posterFile.isEmpty()) {
            File f = new File(it.posterFile);
            if (f.exists()) return it.posterFile;
        }
        if (it.id != null) {
            File f = new File(new File(getFilesDir(), "posters"), posterName(it.id));
            if (f.exists()) return f.getAbsolutePath();
        }
        return null;
    }

    private static String posterName(String id) {
        return (id == null ? "x" : id.replaceAll("[^A-Za-z0-9_.-]", "_")) + ".jpg";
    }

    private String sizeStr(long bytes) {
        if (bytes <= 0) return getString(R.string.downloads_size_zero);
        double mb = bytes / (1024.0 * 1024.0);
        if (mb >= 1024) {
            return getString(
                    R.string.downloads_size_gb,
                    localizedNumber(mb / 1024.0, 1));
        }
        return getString(R.string.downloads_size_mb, localizedNumber(mb, 0));
    }

    private static String localizedNumber(double value, int fractionDigits) {
        NumberFormat format = NumberFormat.getNumberInstance();
        format.setGroupingUsed(false);
        format.setMinimumFractionDigits(fractionDigits);
        format.setMaximumFractionDigits(fractionDigits);
        return format.format(value);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
