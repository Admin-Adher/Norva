package tv.norva.phone;

import android.net.Uri;

import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;

import java.io.IOException;
import java.io.RandomAccessFile;

import javax.crypto.Cipher;

/**
 * media3 {@link androidx.media3.datasource.DataSource} that streams an AES/CTR
 * encrypted offline download and decrypts on the fly.
 *
 * CTR is a stream cipher, so any byte offset maps 1:1 to the same plaintext
 * offset — the file stays fully seekable. Each {@link #read} re-positions a
 * fresh CTR counter at the 16-byte block below the requested position and
 * decrypts a small leading pad it then discards, so the player can scrub
 * anywhere without keeping cross-read cipher state (robust + easy to reason
 * about). The data key never leaves the process: it is unwrapped from the
 * keystore-protected master key before the player starts.
 */
@UnstableApi
final class EncryptedFileDataSource extends BaseDataSource {

    static final class Factory implements androidx.media3.datasource.DataSource.Factory {
        private final byte[] dataKey;
        private final byte[] mediaIv;

        Factory(byte[] dataKey, byte[] mediaIv) {
            this.dataKey = dataKey;
            this.mediaIv = mediaIv;
        }

        @Override
        public EncryptedFileDataSource createDataSource() {
            return new EncryptedFileDataSource(dataKey, mediaIv);
        }
    }

    private final byte[] dataKey;
    private final byte[] mediaIv;
    private RandomAccessFile file;
    private Uri uri;
    private long position;        // absolute plaintext offset of the next read
    private long bytesRemaining;

    EncryptedFileDataSource(byte[] dataKey, byte[] mediaIv) {
        super(/* isNetwork= */ false);
        this.dataKey = dataKey;
        this.mediaIv = mediaIv;
    }

    @Override
    public long open(DataSpec dataSpec) throws IOException {
        try {
            uri = dataSpec.uri;
            transferInitializing(dataSpec);
            String path = dataSpec.uri.getPath();
            if (path == null) throw new IOException("No path in " + dataSpec.uri);
            file = new RandomAccessFile(path, "r");
            long length = file.length();
            position = dataSpec.position;
            if (position > length) throw new IOException("Position past end of file");
            file.seek(position);
            bytesRemaining = dataSpec.length != C.LENGTH_UNSET
                    ? dataSpec.length
                    : length - position;
            transferStarted(dataSpec);
            return bytesRemaining;
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        if (bytesRemaining == 0) return C.RESULT_END_OF_INPUT;
        int toRead = (int) Math.min(length, bytesRemaining);
        byte[] cipherText = new byte[toRead];
        int n = file.read(cipherText, 0, toRead);
        if (n <= 0) return C.RESULT_END_OF_INPUT;
        try {
            int pad = (int) (position & 0x0f); // position % 16
            Cipher cipher = DownloadCrypto.mediaCipher(
                    Cipher.DECRYPT_MODE, dataKey, mediaIv, position - pad);
            byte[] in = new byte[pad + n];
            System.arraycopy(cipherText, 0, in, pad, n);
            byte[] out = cipher.doFinal(in);
            System.arraycopy(out, pad, buffer, offset, n);
        } catch (Exception e) {
            throw new IOException("Decrypt failed", e);
        }
        position += n;
        bytesRemaining -= n;
        bytesTransferred(n);
        return n;
    }

    @Override
    public Uri getUri() {
        return uri;
    }

    @Override
    public void close() throws IOException {
        uri = null;
        try {
            if (file != null) file.close();
        } finally {
            file = null;
            transferEnded();
        }
    }
}
