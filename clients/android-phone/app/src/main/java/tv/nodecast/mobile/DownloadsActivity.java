package tv.nodecast.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.List;
import java.util.Locale;

/**
 * Native "Downloads" screen — the offline library of saved movies/episodes,
 * styled to match the Norva web app (dark canvas, rounded cards, blue accent).
 * Plays a finished download through the encrypted player (no network), shows
 * live progress for in-flight ones, and deletes media + poster. Rebuilt on a
 * light poll so progress advances while visible.
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

    private LinearLayout list;
    private TextView empty;
    private TextView summary;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            render();
            handler.postDelayed(this, 1200);
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

        // Header: title + summary on the left, Close pill on the right.
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout titleCol = new LinearLayout(this);
        titleCol.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("Downloads");
        title.setTextColor(TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        titleCol.addView(title);
        summary = new TextView(this);
        summary.setTextColor(MUTED);
        summary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        summary.setPadding(0, dp(2), 0, 0);
        titleCol.addView(summary);
        header.addView(titleCol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView close = pill("Close", SUBTLE, TEXT);
        close.setOnClickListener(v -> finish());
        header.addView(close);
        container.addView(header);

        empty = new TextView(this);
        empty.setText("No downloads yet.\nTap Download on a movie to watch it offline.");
        empty.setTextColor(MUTED);
        empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(0, dp(64), 0, 0);
        container.addView(empty);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, dp(16), 0, 0);
        container.addView(list);

        scroll.addView(container);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(poll);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(poll);
    }

    private void render() {
        List<DownloadStore.Item> items = DownloadStore.all(this);
        empty.setVisibility(items.isEmpty() ? View.VISIBLE : View.GONE);

        int done = 0;
        long bytes = 0;
        for (DownloadStore.Item it : items) {
            if ("done".equals(it.state)) {
                done++;
                bytes += it.totalBytes;
            }
        }
        summary.setText(items.isEmpty() ? ""
                : done + (done == 1 ? " title" : " titles") + " · " + sizeStr(bytes));

        list.removeAllViews();
        for (DownloadStore.Item it : items) list.addView(card(it));
    }

    private View card(final DownloadStore.Item it) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setBackground(roundedStroke(CARD, CARD_BORDER, 14));
        card.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardLp.bottomMargin = dp(12);
        card.setLayoutParams(cardLp);

        ImageView poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setBackground(rounded(Color.parseColor("#1d1d27"), 10));
        roundCorners(poster, dp(10));
        boolean hasPoster = false;
        if (it.posterFile != null && !it.posterFile.isEmpty()) {
            File pf = new File(it.posterFile);
            if (pf.exists()) {
                try {
                    poster.setImageBitmap(BitmapFactory.decodeFile(pf.getAbsolutePath()));
                    hasPoster = true;
                } catch (Exception ignored) { }
            }
        }
        if (!hasPoster) {
            poster.setImageDrawable(null);
        }
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(dp(56), dp(82));
        plp.rightMargin = dp(14);
        card.addView(poster, plp);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(this);
        t.setText(it.title);
        t.setTextColor(TEXT);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setMaxLines(2);
        mid.addView(t);
        if (it.subtitle != null && !it.subtitle.isEmpty()) {
            TextView sub = new TextView(this);
            sub.setText(it.subtitle);
            sub.setTextColor(MUTED);
            sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
            sub.setMaxLines(1);
            sub.setPadding(0, dp(2), 0, 0);
            mid.addView(sub);
        }
        TextView s = new TextView(this);
        s.setText(statusText(it));
        s.setTextColor("failed".equals(it.state) ? DANGER : MUTED);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        s.setPadding(0, dp(4), 0, 0);
        mid.addView(s);
        card.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if ("done".equals(it.state)) {
            TextView play = pill("Play", ACCENT, TEXT);
            play.setOnClickListener(v -> playLocal(it));
            card.addView(play);
        } else if ("failed".equals(it.state) && it.url != null && !it.url.isEmpty()) {
            TextView retry = pill("Retry", ACCENT, TEXT);
            retry.setOnClickListener(v -> retryItem(it));
            card.addView(retry);
        }
        TextView del = pill("Delete", SUBTLE, MUTED);
        LinearLayout.LayoutParams delLp = (LinearLayout.LayoutParams) del.getLayoutParams();
        delLp.leftMargin = dp(8);
        del.setLayoutParams(delLp);
        del.setOnClickListener(v -> deleteItem(it));
        card.addView(del);

        return card;
    }

    private String statusText(DownloadStore.Item it) {
        switch (it.state) {
            case "done":
                return sizeStr(it.totalBytes) + " · Saved";
            case "downloading":
                int pct = it.totalBytes > 0 ? (int) (it.downloadedBytes * 100 / it.totalBytes) : 0;
                return it.totalBytes > 0
                        ? "Downloading " + pct + "% · " + sizeStr(it.downloadedBytes) + " / " + sizeStr(it.totalBytes)
                        : "Downloading…";
            case "queued":
                return "Queued…";
            case "failed":
                return "Failed" + (it.error != null && !it.error.isEmpty() ? " · " + it.error : "");
            default:
                return it.state;
        }
    }

    private void playLocal(DownloadStore.Item it) {
        File f = new File(it.filePath);
        if (!f.exists()) {
            Toast.makeText(this, "File missing", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent i = new Intent(this, PlayerActivity.class);
        i.putExtra(PlayerActivity.EXTRA_URL, Uri.fromFile(f).toString());
        i.putExtra(PlayerActivity.EXTRA_TITLE, it.title);
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

    private void retryItem(DownloadStore.Item it) {
        it.state = "queued";
        it.error = "";
        DownloadStore.put(this, it);
        Intent svc = new Intent(this, DownloadService.class);
        svc.setAction(DownloadService.ACTION_ENQUEUE);
        svc.putExtra(DownloadService.EXTRA_ID, it.id);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }
        render();
    }

    private void deleteItem(DownloadStore.Item it) {
        try {
            if (it.filePath != null && !it.filePath.isEmpty()) new File(it.filePath).delete();
        } catch (Exception ignored) { }
        try {
            if (it.posterFile != null && !it.posterFile.isEmpty()) new File(it.posterFile).delete();
        } catch (Exception ignored) { }
        DownloadStore.remove(this, it.id);
        render();
    }

    // ---- Styling helpers ----

    /** A rounded "pill" button rendered as a TextView (no Material all-caps grey). */
    private TextView pill(String text, int bg, int textColor) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setTextColor(textColor);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(18), dp(10), dp(18), dp(10));
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
