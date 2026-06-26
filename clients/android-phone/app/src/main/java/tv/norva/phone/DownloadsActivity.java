package tv.norva.phone;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
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
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
    // null = "force the next paint". signature() never returns null (it returns
    // "" for an empty list), so an empty library still re-renders correctly.
    private String lastSignature = null;
    /** Seasons the user has collapsed, keyed "showTitle|season"; survives re-render. */
    private final Set<String> collapsed = new HashSet<>();

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            renderIfChanged();
            handler.postDelayed(this, 1500);
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        scroll.setFitsSystemWindows(true);

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(dp(18), dp(30), dp(18), dp(24));

        // Header row: title + Close.
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("Downloads");
        title.setTextColor(TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView close = pill("Close", SUBTLE, TEXT);
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
        wifiLabel.setText("Wi-Fi only");
        wifiLabel.setTextColor(TEXT);
        wifiLabel.setTypeface(Typeface.DEFAULT_BOLD);
        wifiLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        TextView wifiSub = new TextView(this);
        wifiSub.setText("Only download over Wi-Fi — saves mobile data");
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
        wifi.setContentDescription("Wi-Fi only");
        View.OnClickListener flip = v -> {
            boolean nv = !wifi.isChecked();
            wifi.setChecked(nv);
            DownloadService.setWifiOnly(this, nv);
            wifi.announceForAccessibility(nv ? "Wi-Fi only on" : "Wi-Fi only off");
            renderNow();
        };
        wifi.setOnClickListener(flip);
        wifiRow.setOnClickListener(flip);
        LinearLayout.LayoutParams wifiTogLp = new LinearLayout.LayoutParams(dp(48), dp(28));
        wifiTogLp.leftMargin = dp(12);
        wifiRow.addView(wifi, wifiTogLp);
        LinearLayout.LayoutParams wifiRowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wifiRowLp.topMargin = dp(14);
        container.addView(wifiRow, wifiRowLp);

        LinearLayout clearRow = new LinearLayout(this);
        clearRow.setOrientation(LinearLayout.HORIZONTAL);
        clearRow.setGravity(Gravity.END);
        clearRow.setPadding(0, dp(10), 0, dp(2));
        TextView clearAll = pill("Clear all", SUBTLE, MUTED);
        clearAll.setOnClickListener(v -> confirmClearAll());
        clearRow.addView(clearAll);
        container.addView(clearRow);

        empty = new TextView(this);
        empty.setText("No downloads yet.\nTap Download on a movie or episode to watch it offline.");
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

    @Override
    protected void onResume() {
        super.onResume();
        lastSignature = null; // force a fresh paint
        handler.post(poll);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(poll);
    }

    // ---- Rendering ----

    private void renderNow() {
        lastSignature = null;
        renderIfChanged();
    }

    private void renderIfChanged() {
        List<DownloadStore.Item> items = DownloadStore.all(this);
        String sig = signature(items);
        if (sig.equals(lastSignature)) return;
        lastSignature = sig;
        render(items);
    }

    private String signature(List<DownloadStore.Item> items) {
        StringBuilder sb = new StringBuilder();
        // Include the Wi-Fi gate so the "waiting for Wi-Fi" hint + per-item "Mobile
        // data" button repaint when the network changes (no item state change).
        sb.append(DownloadService.getWifiOnly(this) && !onWifiNow() ? "W;" : ";");
        for (DownloadStore.Item it : items) {
            sb.append(it.id).append(it.state).append(it.downloadedBytes)
              .append(it.allowCellular ? "C" : "")
              .append(it.posterFile == null ? "" : "p").append(';');
        }
        return sb.toString();
    }

    private void render(List<DownloadStore.Item> items) {
        empty.setVisibility(items.isEmpty() ? View.VISIBLE : View.GONE);

        int done = 0, remaining = 0;
        String activeTitle = null;
        int activePct = 0;
        for (DownloadStore.Item it : items) {
            if ("done".equals(it.state)) done++;
            else remaining++;
            if ("downloading".equals(it.state)) {
                activeTitle = it.title;
                activePct = it.totalBytes > 0 ? (int) (it.downloadedBytes * 100 / it.totalBytes) : 0;
            }
        }
        summary.setText(items.isEmpty() ? ""
                : done + (done == 1 ? " title · " : " titles · ") + sizeStr(usedBytes())
                  + " used · " + sizeStr(freeBytes()) + " free");
        if (activeTitle != null) {
            active.setVisibility(View.VISIBLE);
            active.setText("Downloading " + activeTitle + " — " + activePct + "%"
                    + (remaining > 1 ? "  ·  " + (remaining - 1) + " in queue" : ""));
        } else if (remaining > 0) {
            active.setVisibility(View.VISIBLE);
            boolean wifiWait = DownloadService.getWifiOnly(this) && !onWifiNow();
            active.setText(remaining + " in queue" + (wifiWait ? "  ·  waiting for Wi-Fi" : ""));
        } else {
            active.setVisibility(View.GONE);
        }

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
        count.setText(episodes.size() + (episodes.size() == 1 ? " episode" : " episodes"));
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

        final TextView chevron = new TextView(this);
        chevron.setText(collapsed.contains(key) ? "▸" : "▾");
        chevron.setTextColor(MUTED);
        chevron.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.rightMargin = dp(8);
        chevron.setLayoutParams(clp);
        h.addView(chevron);

        TextView label = new TextView(this);
        label.setText(season > 0 ? "Season " + season : "Episodes");
        label.setTextColor(TEXT);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        h.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView c = new TextView(this);
        c.setText(count + (count == 1 ? " episode" : " episodes"));
        c.setTextColor(MUTED);
        c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        h.addView(c);

        h.setOnClickListener(v -> {
            if (collapsed.contains(key)) {
                collapsed.remove(key);
                body.setVisibility(View.VISIBLE);
                chevron.setText("▾");
            } else {
                collapsed.add(key);
                body.setVisibility(View.GONE);
                chevron.setText("▸");
            }
        });
        return h;
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
        if (e > 0) return title.isEmpty() ? "Episode " + e : "E" + e + " · " + title;
        return title.isEmpty() ? "Episode" : title;
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
        sv.addView(actions, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return sv;
    }

    private void addActions(LinearLayout actions, final DownloadStore.Item it) {
        switch (it.state) {
            case "done":
                actions.addView(pillSpaced("Play", ACCENT, TEXT, v -> playLocal(it)));
                actions.addView(pillSpaced("Delete", SUBTLE, MUTED, v -> confirmDelete(it)));
                break;
            case "downloading":
                actions.addView(pillSpaced("Pause", SUBTLE, TEXT, v -> {
                    DownloadService.requestPause(this, it.id);
                    renderNow();
                }));
                actions.addView(pillSpaced("Cancel", SUBTLE, MUTED, v -> confirmDelete(it)));
                break;
            case "paused":
                actions.addView(pillSpaced("Resume", ACCENT, TEXT, v -> {
                    DownloadService.requestResume(this, it.id);
                    renderNow();
                }));
                actions.addView(pillSpaced("Cancel", SUBTLE, MUTED, v -> confirmDelete(it)));
                break;
            case "queued":
                if (DownloadService.getWifiOnly(this) && !onWifiNow() && !it.allowCellular) {
                    actions.addView(pillSpaced("Mobile data", ACCENT, TEXT, v -> {
                        DownloadService.setAllowCellular(this, it.id, true);
                        renderNow();
                    }));
                }
                actions.addView(pillSpaced("▲", SUBTLE, TEXT, v -> {
                    DownloadService.moveInQueue(this, it.id, -1);
                    renderNow();
                }));
                actions.addView(pillSpaced("▼", SUBTLE, TEXT, v -> {
                    DownloadService.moveInQueue(this, it.id, 1);
                    renderNow();
                }));
                actions.addView(pillSpaced("Cancel", SUBTLE, MUTED, v -> confirmDelete(it)));
                break;
            case "failed":
                if (it.url != null && !it.url.isEmpty()) {
                    actions.addView(pillSpaced("Retry", ACCENT, TEXT, v -> {
                        DownloadService.requestResume(this, it.id);
                        renderNow();
                    }));
                }
                actions.addView(pillSpaced("Delete", SUBTLE, MUTED, v -> confirmDelete(it)));
                break;
            default:
                actions.addView(pillSpaced("Delete", SUBTLE, MUTED, v -> confirmDelete(it)));
        }
    }

    private TextView statusText(DownloadStore.Item it) {
        TextView s = new TextView(this);
        s.setTextColor("failed".equals(it.state) ? DANGER : MUTED);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        s.setPadding(0, dp(4), 0, 0);
        switch (it.state) {
            case "done":
                s.setText(sizeStr(it.totalBytes) + " · Saved");
                break;
            case "downloading": {
                int pct = it.totalBytes > 0 ? (int) (it.downloadedBytes * 100 / it.totalBytes) : 0;
                s.setText(it.totalBytes > 0
                        ? "Downloading " + pct + "% · " + sizeStr(it.downloadedBytes) + " / " + sizeStr(it.totalBytes)
                        : "Downloading…");
                break;
            }
            case "paused":
                s.setText("Paused · " + sizeStr(it.downloadedBytes)
                        + (it.totalBytes > 0 ? " / " + sizeStr(it.totalBytes) : ""));
                break;
            case "queued":
                s.setText("Queued");
                break;
            case "failed":
                s.setText("Failed" + (it.error != null && !it.error.isEmpty() ? " · " + it.error : ""));
                break;
            default:
                s.setText(it.state);
        }
        return s;
    }

    // ---- Actions ----

    private void playLocal(DownloadStore.Item it) {
        File f = new File(it.filePath);
        if (!f.exists()) {
            Toast.makeText(this, "File missing", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent i = new Intent(this, PlayerActivity.class);
        i.putExtra(PlayerActivity.EXTRA_URL, Uri.fromFile(f).toString());
        i.putExtra(PlayerActivity.EXTRA_TITLE, it.subtitle != null && !it.subtitle.isEmpty()
                ? it.title + " — " + it.subtitle : it.title);
        i.putExtra(PlayerActivity.EXTRA_LOCAL, true);
        i.putExtra(PlayerActivity.EXTRA_WRAPPED_KEY, it.wrappedKey);
        i.putExtra(PlayerActivity.EXTRA_KEY_IV, it.keyIv);
        i.putExtra(PlayerActivity.EXTRA_MEDIA_IV, it.mediaIv);
        i.putExtra(PlayerActivity.EXTRA_CONTAINER, it.container);
        i.putExtra(PlayerActivity.EXTRA_SOURCE_ID, it.sourceId);
        i.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, it.itemType);
        i.putExtra(PlayerActivity.EXTRA_ITEM_ID, it.itemId);
        startActivity(i);
    }

    private void confirmDelete(final DownloadStore.Item it) {
        boolean finished = "done".equals(it.state) || "failed".equals(it.state);
        String label = it.subtitle != null && !it.subtitle.isEmpty()
                ? it.title + " — " + it.subtitle : it.title;
        styledConfirm(
                finished ? "Delete download?" : "Cancel download?",
                (finished ? "Delete \"" : "Cancel and remove \"") + label
                        + "\"? This frees the storage it uses.",
                finished ? "Delete" : "Cancel download",
                () -> {
                    DownloadService.requestCancel(this, it.id);
                    Toast.makeText(this, "Removed", Toast.LENGTH_SHORT).show();
                    renderNow();
                });
    }

    private void confirmClearAll() {
        List<DownloadStore.Item> items = DownloadStore.all(this);
        if (items.isEmpty()) return;
        styledConfirm(
                "Delete all downloads?",
                "Remove all " + items.size() + " downloads and free their storage?",
                "Delete all",
                () -> {
                    for (DownloadStore.Item it : DownloadStore.all(this)) {
                        DownloadService.requestCancel(this, it.id);
                    }
                    Toast.makeText(this, "All downloads removed", Toast.LENGTH_SHORT).show();
                    renderNow();
                });
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

        TextView keep = pill("Keep", SUBTLE, TEXT);
        keep.setOnClickListener(v -> dialog.dismiss());
        actions.addView(keep);

        actions.addView(pillSpaced(confirmLabel, DANGER, TEXT, v -> {
            dialog.dismiss();
            if (onConfirm != null) onConfirm.run();
        }));

        cardView.addView(actions);

        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(dp(24), 0, dp(24), 0);
        wrap.addView(cardView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        dialog.setContentView(wrap);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(0x00000000));
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        }
        dialog.show();
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
        String path = posterPathFor(it);
        if (path != null) {
            try {
                poster.setImageBitmap(BitmapFactory.decodeFile(path));
            } catch (Exception ignored) { }
        }
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

    private static String sizeStr(long bytes) {
        if (bytes <= 0) return "0 MB";
        double mb = bytes / (1024.0 * 1024.0);
        if (mb >= 1024) return String.format(Locale.US, "%.1f GB", mb / 1024.0);
        return String.format(Locale.US, "%.0f MB", mb);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
