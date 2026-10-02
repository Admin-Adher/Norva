package tv.norva.playback;

import androidx.media3.common.C;
import androidx.media3.common.DataReader;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.ParsableByteArray;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.extractor.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;

/** Recognize MPEG-4 Part 2 in legacy VFW Matroska without rewriting the file.
 * Media3 1.5.1 publishes XVID/DX50 as video/x-unknown. The same elementary
 * stream is already supported as video/mp4v-es. Audio, samples, timestamps,
 * byte offsets and seeking remain entirely owned by the original extractor.
 */
@UnstableApi
final class MatroskaFourccExtractor implements Extractor {
    static final int MAX_HEADER_BYTES = 64 * 1024;
    private final Extractor delegate;
    private Map<Integer, byte[]> mpeg4Tracks = Collections.emptyMap();
    private boolean inspected;

    MatroskaFourccExtractor(Extractor delegate) { this.delegate = delegate; }
    @Override public boolean sniff(ExtractorInput input) throws IOException { return delegate.sniff(input); }
    @Override public void init(ExtractorOutput output) {
        delegate.init(new ExtractorOutput() {
            @Override public TrackOutput track(int id, int type) {
                TrackOutput sink = output.track(id, type);
                if (type != C.TRACK_TYPE_VIDEO) return sink;
                return new TrackOutput() {
                    @Override public void format(Format format) {
                        byte[] initialization = mpeg4Tracks.get(id);
                        if (initialization != null && MimeTypes.VIDEO_UNKNOWN.equals(format.sampleMimeType)) {
                            format = format.buildUpon().setSampleMimeType(MimeTypes.VIDEO_MP4V)
                                    .setInitializationData(initialization.length == 0
                                            ? Collections.emptyList() : Collections.singletonList(initialization))
                                    .build();
                        }
                        sink.format(format);
                    }
                    @Override public int sampleData(DataReader input, int length, boolean allowEnd, int part) throws IOException {
                        return sink.sampleData(input, length, allowEnd, part);
                    }
                    @Override public void sampleData(ParsableByteArray data, int length, int part) { sink.sampleData(data, length, part); }
                    @Override public void sampleMetadata(long timeUs, int flags, int size, int offset, CryptoData crypto) {
                        sink.sampleMetadata(timeUs, flags, size, offset, crypto);
                    }
                };
            }
            @Override public void endTracks() { output.endTracks(); }
            @Override public void seekMap(SeekMap map) { output.seekMap(map); }
        });
    }
    @Override public int read(ExtractorInput input, PositionHolder position) throws IOException {
        if (!inspected && input.getPosition() == 0) {
            inspected = true;
            byte[] prefix = new byte[MAX_HEADER_BYTES];
            int length = 0;
            try {
                input.resetPeekPosition();
                while (length < prefix.length) {
                    int read = input.peek(prefix, length, Math.min(4096, prefix.length - length));
                    if (read <= 0) break;
                    length += read;
                    Map<Integer, byte[]> parsed = parseTracks(prefix, length);
                    if (parsed != null) { mpeg4Tracks = parsed; break; }
                }
            } finally { input.resetPeekPosition(); }
        }
        return delegate.read(input, position);
    }
    @Override public void seek(long position, long timeUs) { delegate.seek(position, timeUs); }
    @Override public void release() { delegate.release(); }

    // null means an incomplete prefix. A complete Tracks element with no proven
    // MPEG-4 VFW track returns an empty map; byte strings elsewhere never count.
    static Map<Integer, byte[]> parseTracks(byte[] data, int length) {
        if (length < 0 || length > data.length || length > MAX_HEADER_BYTES) return Collections.emptyMap();
        int cursor = 0;
        while (cursor < length) {
            Element top = element(data, cursor, length);
            if (top == null) return null;
            if (top.id == 0x18538067L) {
                cursor = top.start;
                while (cursor < length) {
                    Element child = element(data, cursor, length);
                    if (child == null) return null;
                    if (child.id == 0x1f43b675L) return Collections.emptyMap();
                    if (child.end > length) return null;
                    if (child.id == 0x1654ae6bL) return tracks(data, child.start, (int) child.end);
                    cursor = (int) child.end;
                }
                return null;
            }
            if (top.end > length) return null;
            cursor = (int) top.end;
        }
        return null;
    }
    private static Map<Integer, byte[]> tracks(byte[] data, int start, int end) {
        Map<Integer, byte[]> result = new HashMap<>();
        Set<Integer> seen = new HashSet<>();
        while (start < end) {
            Element entry = element(data, start, end);
            if (entry == null || entry.end > end) return Collections.emptyMap();
            if (entry.id == 0xae) {
                int number = 0, type = 0;
                String codec = "";
                byte[] privateData = null;
                int cursor = entry.start;
                while (cursor < entry.end) {
                    Element field = element(data, cursor, (int) entry.end);
                    if (field == null || field.end > entry.end) return Collections.emptyMap();
                    int size = (int) field.end - field.start;
                    if ((field.id == 0xd7 || field.id == 0x83) && size > 0 && size <= 4) {
                        long value = 0;
                        for (int i = field.start; i < field.end; i++) value = (value << 8) | (data[i] & 255);
                        if (value > 0 && value <= Integer.MAX_VALUE) {
                            if (field.id == 0xd7) number = (int) value; else type = (int) value;
                        }
                    } else if (field.id == 0x86 && size <= 64) {
                        codec = new String(data, field.start, size, StandardCharsets.US_ASCII);
                    } else if (field.id == 0x63a2 && size >= 40) {
                        privateData = Arrays.copyOfRange(data, field.start, (int) field.end);
                    }
                    cursor = (int) field.end;
                }
                if (number > 0 && !seen.add(number)) return Collections.emptyMap();
                if (number > 0 && type == 1 && "V_MS/VFW/FOURCC".equals(codec) && privateData != null
                        && privateData[0] == 40 && privateData[1] == 0
                        && privateData[2] == 0 && privateData[3] == 0) {
                    String tag = new String(privateData, 16, 4, StandardCharsets.US_ASCII);
                    // Only the two MPEG-4 ASP aliases observed here are admitted.
                    // VC-1/H.263/unknown FourCC remain Media3's responsibility.
                    if ("XVID".equals(tag) || "DX50".equals(tag)) {
                        result.put(number, Arrays.copyOfRange(privateData, 40, privateData.length));
                    }
                }
            }
            start = (int) entry.end;
        }
        return result;
    }
    private static Element element(byte[] data, int offset, int limit) {
        if (offset >= limit) return null;
        int idBytes = width(data[offset]);
        if (idBytes > 4 || idBytes == 0 || offset + idBytes >= limit) return null;
        long id = 0;
        for (int i = 0; i < idBytes; i++) id = (id << 8) | (data[offset + i] & 255);
        int sizeAt = offset + idBytes, sizeBytes = width(data[sizeAt]);
        if (sizeBytes == 0 || sizeAt + sizeBytes > limit) return null;
        long size = data[sizeAt] & (255 >>> sizeBytes);
        for (int i = 1; i < sizeBytes; i++) size = (size << 8) | (data[sizeAt + i] & 255);
        int start = sizeAt + sizeBytes;
        return new Element(id, start, start + size);
    }
    private static int width(byte value) {
        for (int i = 1; i <= 8; i++) if (((value & 255) & (256 >>> i)) != 0) return i;
        return 0;
    }
    private static final class Element {
        final long id, end; final int start;
        Element(long id, int start, long end) { this.id = id; this.start = start; this.end = end; }
    }
}
