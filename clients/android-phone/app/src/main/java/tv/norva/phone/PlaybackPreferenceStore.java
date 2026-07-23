package tv.norva.phone;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Pure-Java persistence policy for audio and subtitle choices.
 *
 * <p>The Android integration supplies a tiny {@link Backend} adapter backed by
 * SharedPreferences (and may mirror resolved choices to the cloud). Scope keys
 * are SHA-256 digests so account identifiers and provider IDs are not exposed
 * in preference file keys.</p>
 */
public final class PlaybackPreferenceStore {

    private static final String PREFIX = "norva.playback.v1.";
    private static final String FORMAT_VERSION = "v1";

    public interface Backend {
        String get(String key);
        void put(String key, String value);
        void remove(String key);

        default boolean contains(String key) {
            return get(key) != null;
        }
    }

    public static final class Scope {
        private final String accountId;
        private final String profileId;
        private final String sourceId;
        private final String versionKey;
        private final String itemType;
        private final String itemId;
        private final String seriesId;

        private Scope(Builder builder) {
            accountId = clean(builder.accountId);
            profileId = clean(builder.profileId);
            sourceId = clean(builder.sourceId);
            versionKey = clean(builder.versionKey);
            itemType = clean(builder.itemType).isEmpty() ? "movie" : clean(builder.itemType);
            itemId = clean(builder.itemId);
            seriesId = clean(builder.seriesId);
        }

        public static Builder builder() {
            return new Builder();
        }

        public boolean canUseProfileScope() {
            return !accountId.isEmpty() && !profileId.isEmpty();
        }

        public boolean canUseSeriesScope() {
            return canUseProfileScope() && !sourceId.isEmpty() && !seriesId.isEmpty();
        }

        public boolean canUseExactScope() {
            return canUseProfileScope()
                    && !sourceId.isEmpty()
                    && !versionKey.isEmpty()
                    && !itemId.isEmpty();
        }

        public String getAccountId() {
            return accountId;
        }

        public String getProfileId() {
            return profileId;
        }

        public String getSourceId() {
            return sourceId;
        }

        public String getVersionKey() {
            return versionKey;
        }

        public String getItemType() {
            return itemType;
        }

        public String getItemId() {
            return itemId;
        }

        public String getSeriesId() {
            return seriesId;
        }

        public static final class Builder {
            private String accountId;
            private String profileId;
            private String sourceId;
            private String versionKey;
            private String itemType;
            private String itemId;
            private String seriesId;

            public Builder accountId(String value) {
                accountId = value;
                return this;
            }

            public Builder profileId(String value) {
                profileId = value;
                return this;
            }

            public Builder sourceId(String value) {
                sourceId = value;
                return this;
            }

            public Builder versionKey(String value) {
                versionKey = value;
                return this;
            }

            public Builder itemType(String value) {
                itemType = value;
                return this;
            }

            public Builder itemId(String value) {
                itemId = value;
                return this;
            }

            public Builder seriesId(String value) {
                seriesId = value;
                return this;
            }

            public Scope build() {
                return new Scope(this);
            }
        }
    }

    public static final class Preferences {
        private final TrackSelectionResolver.Preference audio;
        private final TrackSelectionResolver.Preference subtitle;

        public Preferences(
                TrackSelectionResolver.Preference audio,
                TrackSelectionResolver.Preference subtitle
        ) {
            this.audio = audio;
            this.subtitle = subtitle;
        }

        public static Preferences empty() {
            return new Preferences(null, null);
        }

        public TrackSelectionResolver.Preference getAudio() {
            return audio;
        }

        public TrackSelectionResolver.Preference getSubtitle() {
            return subtitle;
        }

        public Preferences withAudio(TrackSelectionResolver.Preference value) {
            return new Preferences(value, subtitle);
        }

        public Preferences withSubtitle(TrackSelectionResolver.Preference value) {
            return new Preferences(audio, value);
        }

        public boolean isEmpty() {
            return audio == null && subtitle == null;
        }

        @Override
        public boolean equals(Object value) {
            if (this == value) return true;
            if (!(value instanceof Preferences)) return false;
            Preferences other = (Preferences) value;
            return equal(audio, other.audio) && equal(subtitle, other.subtitle);
        }

        @Override
        public int hashCode() {
            return 31 * (audio == null ? 0 : audio.hashCode())
                    + (subtitle == null ? 0 : subtitle.hashCode());
        }
    }

    private final Backend backend;

    public PlaybackPreferenceStore(Backend backend) {
        if (backend == null) throw new IllegalArgumentException("backend is required");
        this.backend = backend;
    }

    /**
     * Resolve each track type independently: exact file, then series, then
     * profile, then caller-provided default.
     */
    public Preferences resolve(Scope scope, Preferences defaults) {
        Preferences fallback = defaults == null ? Preferences.empty() : defaults;
        if (scope == null) return fallback;

        Preferences exact = scope.canUseExactScope()
                ? read(keyForExact(scope)) : Preferences.empty();
        Preferences series = scope.canUseSeriesScope()
                ? read(keyForSeries(scope)) : Preferences.empty();
        Preferences profile = scope.canUseProfileScope()
                ? read(keyForProfile(scope)) : Preferences.empty();

        TrackSelectionResolver.Preference audio = first(
                exact.audio, series.audio, profile.audio, fallback.audio);
        TrackSelectionResolver.Preference subtitle = first(
                exact.subtitle, series.subtitle, profile.subtitle, fallback.subtitle);
        return new Preferences(audio, subtitle);
    }

    public boolean saveExact(Scope scope, Preferences preferences) {
        if (scope == null || !scope.canUseExactScope()) return false;
        write(keyForExact(scope), preferences);
        return true;
    }

    public boolean saveSeries(Scope scope, Preferences preferences) {
        if (scope == null || !scope.canUseSeriesScope()) return false;
        write(keyForSeries(scope), preferences);
        return true;
    }

    public boolean saveProfile(Scope scope, Preferences preferences) {
        if (scope == null || !scope.canUseProfileScope()) return false;
        write(keyForProfile(scope), preferences);
        return true;
    }

    public boolean saveExactAudio(
            Scope scope, TrackSelectionResolver.Preference preference) {
        return updateExact(scope, preference, null, true);
    }

    public boolean saveExactSubtitle(
            Scope scope, TrackSelectionResolver.Preference preference) {
        return updateExact(scope, null, preference, false);
    }

    public boolean saveSeriesAudio(
            Scope scope, TrackSelectionResolver.Preference preference) {
        return updateSeries(scope, preference, null, true);
    }

    public boolean saveSeriesSubtitle(
            Scope scope, TrackSelectionResolver.Preference preference) {
        return updateSeries(scope, null, preference, false);
    }

    public boolean saveProfileAudio(
            Scope scope, TrackSelectionResolver.Preference preference) {
        return updateProfile(scope, preference, null, true);
    }

    public boolean saveProfileSubtitle(
            Scope scope, TrackSelectionResolver.Preference preference) {
        return updateProfile(scope, null, preference, false);
    }

    /**
     * One-shot conversion from the old "norva_subprefs" value. The caller owns
     * the old SharedPreferences file and should remove its old key only when
     * this method returns true.
     */
    public boolean migrateLegacySubtitle(Scope scope, String legacyValue) {
        if (scope == null || !scope.canUseExactScope()) return false;
        String value = clean(legacyValue);
        if (value.isEmpty()) return false;

        String key = keyForExact(scope);
        Preferences existing = read(key);
        if (existing.subtitle != null) return false;

        TrackSelectionResolver.Preference migrated;
        if ("__off__".equals(value)) {
            migrated = TrackSelectionResolver.Preference.off();
        } else if ("__on__".equals(value)) {
            migrated = TrackSelectionResolver.Preference.anySelected();
        } else {
            String language = TrackSelectionResolver.normalizeLanguage(value);
            if (language.isEmpty()) return false;
            migrated = TrackSelectionResolver.Preference.selected(
                    "", language, TrackSelectionResolver.Role.UNKNOWN);
        }
        write(key, existing.withSubtitle(migrated));
        return true;
    }

    /** Reproduces the key used by the old "norva_subprefs" file. */
    public static String legacySubtitleKey(String itemType, String itemId) {
        String id = clean(itemId);
        if (id.isEmpty()) return null;
        String type = clean(itemType);
        return (type.isEmpty() ? "movie" : type) + ":" + id;
    }

    private boolean updateExact(
            Scope scope,
            TrackSelectionResolver.Preference audio,
            TrackSelectionResolver.Preference subtitle,
            boolean updateAudio
    ) {
        if (scope == null || !scope.canUseExactScope()) return false;
        String key = keyForExact(scope);
        Preferences current = read(key);
        write(key, updateAudio ? current.withAudio(audio) : current.withSubtitle(subtitle));
        return true;
    }

    private boolean updateSeries(
            Scope scope,
            TrackSelectionResolver.Preference audio,
            TrackSelectionResolver.Preference subtitle,
            boolean updateAudio
    ) {
        if (scope == null || !scope.canUseSeriesScope()) return false;
        String key = keyForSeries(scope);
        Preferences current = read(key);
        write(key, updateAudio ? current.withAudio(audio) : current.withSubtitle(subtitle));
        return true;
    }

    private boolean updateProfile(
            Scope scope,
            TrackSelectionResolver.Preference audio,
            TrackSelectionResolver.Preference subtitle,
            boolean updateAudio
    ) {
        if (scope == null || !scope.canUseProfileScope()) return false;
        String key = keyForProfile(scope);
        Preferences current = read(key);
        write(key, updateAudio ? current.withAudio(audio) : current.withSubtitle(subtitle));
        return true;
    }

    private Preferences read(String key) {
        String serialized = backend.get(key);
        if (serialized == null || serialized.isEmpty()) return Preferences.empty();
        return decode(serialized);
    }

    private void write(String key, Preferences preferences) {
        Preferences safe = preferences == null ? Preferences.empty() : preferences;
        if (safe.isEmpty()) {
            backend.remove(key);
        } else {
            backend.put(key, encode(safe));
        }
    }

    private static String encode(Preferences preferences) {
        return FORMAT_VERSION + "|" + encodePreference(preferences.audio)
                + "|" + encodePreference(preferences.subtitle);
    }

    private static Preferences decode(String serialized) {
        try {
            String[] fields = serialized.split("\\|", -1);
            if (fields.length != 3 || !FORMAT_VERSION.equals(fields[0])) {
                return Preferences.empty();
            }
            return new Preferences(
                    decodePreference(fields[1]),
                    decodePreference(fields[2]));
        } catch (RuntimeException ignored) {
            // Corrupt/local data must never block playback.
            return Preferences.empty();
        }
    }

    private static String encodePreference(TrackSelectionResolver.Preference preference) {
        if (preference == null) return "";
        if (preference.isDisabled()) return "off";
        return "on," + urlEncode(preference.getStableId())
                + "," + urlEncode(preference.getLanguage())
                + "," + preference.getRole().name();
    }

    private static TrackSelectionResolver.Preference decodePreference(String value) {
        if (value == null || value.isEmpty()) return null;
        if ("off".equals(value)) return TrackSelectionResolver.Preference.off();
        String[] fields = value.split(",", -1);
        if (fields.length != 4 || !"on".equals(fields[0])) return null;
        return TrackSelectionResolver.Preference.selected(
                urlDecode(fields[1]),
                urlDecode(fields[2]),
                TrackSelectionResolver.Role.from(fields[3]));
    }

    private static String keyForExact(Scope scope) {
        return PREFIX + "exact." + digest(
                scope.accountId, scope.profileId, scope.sourceId, scope.versionKey,
                scope.itemType, scope.itemId);
    }

    private static String keyForSeries(Scope scope) {
        return PREFIX + "series." + digest(
                scope.accountId, scope.profileId, scope.sourceId, scope.seriesId);
    }

    private static String keyForProfile(Scope scope) {
        return PREFIX + "profile." + digest(scope.accountId, scope.profileId);
    }

    private static String digest(String... fields) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String field : fields) {
                digest.update(clean(field).getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
            }
            byte[] bytes = digest.digest();
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                result.append(Character.forDigit((value >>> 4) & 0xf, 16));
                result.append(Character.forDigit(value & 0xf, 16));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static String urlEncode(String value) {
        try {
            return URLEncoder.encode(clean(value), StandardCharsets.UTF_8.name());
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (Exception invalid) {
            return "";
        }
    }

    @SafeVarargs
    private static <T> T first(T... values) {
        if (values == null) return null;
        for (T value : values) {
            if (value != null) return value;
        }
        return null;
    }

    private static boolean equal(Object left, Object right) {
        return left == right || (left != null && left.equals(right));
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
