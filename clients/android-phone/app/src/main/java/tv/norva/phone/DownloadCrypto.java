package tv.norva.phone;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Envelope encryption for offline downloads.
 *
 * Each download gets a random 256-bit data key (DK) used with AES/CTR to
 * encrypt the media bytes — CTR is a stream cipher, so the encrypted file stays
 * fully seekable (any byte offset maps 1:1 to the same plaintext offset). The
 * DK is never stored in the clear: it is wrapped (AES/GCM) by a master key (MK)
 * that lives in the AndroidKeyStore — hardware-backed when available and
 * non-extractable — so a copied movie file + manifest can't be decrypted off
 * the device. The CTR initial counter (IV) is public and stored alongside.
 */
final class DownloadCrypto {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String MASTER_ALIAS = "norva_dl_master";
    private static final String WRAP_TRANSFORM = "AES/GCM/NoPadding";
    private static final String MEDIA_TRANSFORM = "AES/CTR/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private DownloadCrypto() { }

    /** The non-extractable master key in the keystore, created on first use. */
    private static SecretKey masterKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(MASTER_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(MASTER_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        new SecureRandom().nextBytes(b);
        return b;
    }

    /** A fresh 256-bit media data key. */
    static byte[] newDataKey() {
        return randomBytes(32);
    }

    /** A fresh 128-bit CTR initial counter. */
    static byte[] newMediaIv() {
        return randomBytes(16);
    }

    /** Result of wrapping a data key: ciphertext + the GCM IV used to wrap it. */
    static final class Wrapped {
        final byte[] blob;
        final byte[] iv;

        Wrapped(byte[] blob, byte[] iv) {
            this.blob = blob;
            this.iv = iv;
        }
    }

    static Wrapped wrapDataKey(byte[] dataKey) throws Exception {
        Cipher c = Cipher.getInstance(WRAP_TRANSFORM);
        c.init(Cipher.ENCRYPT_MODE, masterKey());
        byte[] iv = c.getIV();
        byte[] blob = c.doFinal(dataKey);
        return new Wrapped(blob, iv);
    }

    static byte[] unwrapDataKey(byte[] blob, byte[] iv) throws Exception {
        Cipher c = Cipher.getInstance(WRAP_TRANSFORM);
        c.init(Cipher.DECRYPT_MODE, masterKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return c.doFinal(blob);
    }

    /**
     * An AES/CTR cipher whose counter is positioned at {@code byteOffset}, which
     * MUST be a multiple of 16 (one AES block). Used both to encrypt
     * sequentially while downloading (offset advances) and to decrypt a seek in
     * the player (re-positioned per read).
     */
    static Cipher mediaCipher(int mode, byte[] dataKey, byte[] mediaIv, long byteOffset) throws Exception {
        Cipher c = Cipher.getInstance(MEDIA_TRANSFORM);
        byte[] counter = counterForOffset(mediaIv, byteOffset);
        c.init(mode, new SecretKeySpec(dataKey, "AES"), new IvParameterSpec(counter));
        return c;
    }

    /** The 128-bit IV advanced by {@code byteOffset / 16} blocks (big-endian add). */
    static byte[] counterForOffset(byte[] mediaIv, long byteOffset) {
        byte[] counter = mediaIv.clone();
        long add = byteOffset / 16;
        int carry = 0;
        for (int i = counter.length - 1; i >= 0; i--) {
            int addByte = (int) (add & 0xff);
            add >>>= 8;
            int sum = (counter[i] & 0xff) + addByte + carry;
            counter[i] = (byte) (sum & 0xff);
            carry = sum >>> 8;
            if (add == 0 && carry == 0) break;
        }
        return counter;
    }

    static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    static byte[] unb64(String s) {
        return Base64.decode(s, Base64.NO_WRAP);
    }
}
