package tv.norva.tv;

import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;

import androidx.tvprovider.media.tv.TvContractCompat;
import androidx.tvprovider.media.tv.WatchNextProgram;

/**
 * Publishes in-progress titles to the Android TV launcher's "Play Next" row.
 *
 * Row identity is COLUMN_INTERNAL_PROVIDER_ID = "sourceId:itemType:itemId".
 * The TV provider forbids WHERE selections on the watch-next table, so lookup
 * iterates the app's own rows (an app only ever sees its own programs, and a
 * household has a handful at most). Clicking a card fires
 * norva://open?sourceId=..&itemType=..&itemId=.. back into MainActivity.
 *
 * All entry points are best-effort: launchers without the TV provider (or with
 * the permission revoked) just no-op.
 */
final class WatchNextHelper {

    private WatchNextHelper() { }

    private static String providerId(String sourceId, String itemType, String itemId) {
        return sourceId + ":" + (itemType == null ? "movie" : itemType) + ":" + itemId;
    }

    static void publishContinue(Context ctx, String sourceId, String itemType, String itemId,
                                String title, String posterUrl, long positionMs, long durationMs) {
        if (Build.VERSION.SDK_INT < 26) return;
        if (sourceId == null || itemId == null || title == null || title.isEmpty()) return;
        // The launcher renders nothing without artwork — skip rather than show a broken card.
        if (posterUrl == null || posterUrl.isEmpty()) return;
        try {
            Uri deepLink = Uri.parse("norva://open")
                    .buildUpon()
                    .appendQueryParameter("sourceId", sourceId)
                    .appendQueryParameter("itemType", itemType == null ? "movie" : itemType)
                    .appendQueryParameter("itemId", itemId)
                    .build();
            Intent open = new Intent(Intent.ACTION_VIEW, deepLink).setPackage(ctx.getPackageName());

            WatchNextProgram.Builder b = new WatchNextProgram.Builder()
                    .setType("episode".equals(itemType)
                            ? TvContractCompat.PreviewProgramColumns.TYPE_TV_EPISODE
                            : TvContractCompat.PreviewProgramColumns.TYPE_MOVIE)
                    .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
                    .setLastEngagementTimeUtcMillis(System.currentTimeMillis())
                    .setTitle(title)
                    .setPosterArtUri(Uri.parse(posterUrl))
                    .setIntent(open)
                    .setInternalProviderId(providerId(sourceId, itemType, itemId));
            if (positionMs > 0) b.setLastPlaybackPositionMillis((int) Math.min(positionMs, Integer.MAX_VALUE));
            if (durationMs > 0) b.setDurationMillis((int) Math.min(durationMs, Integer.MAX_VALUE));
            ContentValues values = b.build().toContentValues();

            long existing = findRow(ctx, providerId(sourceId, itemType, itemId));
            if (existing >= 0) {
                ctx.getContentResolver().update(
                        ContentUris.withAppendedId(TvContractCompat.WatchNextPrograms.CONTENT_URI, existing),
                        values, null, null);
            } else {
                ctx.getContentResolver().insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, values);
            }
        } catch (Exception ignored) {
            // Launchers without the TV provider — Play Next simply stays empty.
        }
    }

    static void remove(Context ctx, String sourceId, String itemType, String itemId) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            long row = findRow(ctx, providerId(sourceId, itemType, itemId));
            if (row >= 0) {
                ctx.getContentResolver().delete(
                        ContentUris.withAppendedId(TvContractCompat.WatchNextPrograms.CONTENT_URI, row),
                        null, null);
            }
        } catch (Exception ignored) { }
    }

    private static long findRow(Context ctx, String providerId) {
        String[] projection = {
                TvContractCompat.WatchNextPrograms._ID,
                TvContractCompat.WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID,
        };
        try (Cursor c = ctx.getContentResolver().query(
                TvContractCompat.WatchNextPrograms.CONTENT_URI, projection, null, null, null)) {
            if (c == null) return -1;
            int idCol = c.getColumnIndex(TvContractCompat.WatchNextPrograms._ID);
            int pidCol = c.getColumnIndex(TvContractCompat.WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID);
            while (c.moveToNext()) {
                if (providerId.equals(c.getString(pidCol))) return c.getLong(idCol);
            }
        } catch (Exception ignored) { }
        return -1;
    }
}
