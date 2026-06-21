package tv.nodecast.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.util.List;
import java.util.Locale;

/**
 * Native "Downloads" screen — the offline library of saved movies. Plays a
 * finished download through the encrypted player (no network), shows live
 * progress for in-flight ones, and deletes both the encrypted media and its
 * poster. Rebuilt on a light poll so progress advances while visible.
 */
public final class DownloadsActivity extends Activity {

    private LinearLayout list;
    private TextView empty;
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
        scroll.setBackgroundColor(Color.parseColor("#0a0a0f"));
        scroll.setFitsSystemWindows(true);

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        container.setPadding(pad, dp(28), pad, pad);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("Downloads");
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button close = new Button(this);
        close.setText("Close");
        close.setTextColor(Color.WHITE);
        close.setBackgroundColor(Color.parseColor("#272d3a"));
        close.setOnClickListener(v -> finish());
        header.addView(close);
        container.addView(header);

        empty = new TextView(this);
        empty.setText("No downloads yet.\nTap Download on a movie to watch it offline.");
        empty.setTextColor(Color.parseColor("#a1a1aa"));
        empty.setTextSize(15);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(0, dp(48), 0, 0);
        container.addView(empty);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, dp(8), 0, 0);
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
        list.removeAllViews();
        for (DownloadStore.Item it : items) list.addView(row(it));
    }

    private View row(final DownloadStore.Item it) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(10), 0, dp(10));

        ImageView poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setBackgroundColor(Color.parseColor("#18181f"));
        if (it.posterFile != null && !it.posterFile.isEmpty()) {
            File pf = new File(it.posterFile);
            if (pf.exists()) {
                try {
                    poster.setImageBitmap(BitmapFactory.decodeFile(pf.getAbsolutePath()));
                } catch (Exception ignored) { }
            }
        }
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(dp(58), dp(86));
        plp.rightMargin = dp(12);
        row.addView(poster, plp);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(this);
        t.setText(it.title);
        t.setTextColor(Color.WHITE);
        t.setTextSize(16);
        t.setMaxLines(2);
        mid.addView(t);
        TextView s = new TextView(this);
        s.setText(statusText(it));
        s.setTextColor("failed".equals(it.state)
                ? Color.parseColor("#ef4444") : Color.parseColor("#a1a1aa"));
        s.setTextSize(13);
        s.setPadding(0, dp(4), 0, 0);
        mid.addView(s);
        row.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if ("done".equals(it.state)) {
            Button play = new Button(this);
            play.setText("Play");
            play.setTextColor(Color.WHITE);
            play.setBackgroundColor(Color.parseColor("#3B82F6"));
            play.setOnClickListener(v -> playLocal(it));
            row.addView(play);
        } else if ("failed".equals(it.state) && it.url != null && !it.url.isEmpty()) {
            Button retry = new Button(this);
            retry.setText("Retry");
            retry.setTextColor(Color.WHITE);
            retry.setBackgroundColor(Color.parseColor("#3B82F6"));
            retry.setOnClickListener(v -> retryItem(it));
            row.addView(retry);
        }
        Button del = new Button(this);
        del.setText("Delete");
        del.setTextColor(Color.WHITE);
        del.setBackgroundColor(Color.parseColor("#272d3a"));
        del.setOnClickListener(v -> deleteItem(it));
        row.addView(del);

        return row;
    }

    private String statusText(DownloadStore.Item it) {
        switch (it.state) {
            case "done":
                return sizeStr(it.totalBytes) + " · Saved";
            case "downloading":
                int pct = it.totalBytes > 0 ? (int) (it.downloadedBytes * 100 / it.totalBytes) : 0;
                return "Downloading " + pct + "%";
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

    private static String sizeStr(long bytes) {
        if (bytes <= 0) return "";
        double mb = bytes / (1024.0 * 1024.0);
        if (mb >= 1024) return String.format(Locale.US, "%.1f GB", mb / 1024.0);
        return String.format(Locale.US, "%.0f MB", mb);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
