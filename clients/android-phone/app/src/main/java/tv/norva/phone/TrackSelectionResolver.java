package tv.norva.phone;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Pure-Java track preference matching.
 *
 * <p>Media3 {@code TrackGroup} instances are intentionally not stored here: a
 * fallback URL, a manifest refresh, Cast hand-off, or an app restart may create
 * entirely new groups. A preference is instead represented by stable facts
 * (identifier, language and role), then resolved against the tracks that exist
 * for the current file.</p>
 */
public final class TrackSelectionResolver {

    private TrackSelectionResolver() {}

    public enum Role {
        MAIN,
        ORIGINAL,
        DUB,
        AUDIO_DESCRIPTION,
        COMMENTARY,
        FULL,
        FORCED,
        SDH,
        UNKNOWN;

        public static Role from(String value) {
            if (value == null) return UNKNOWN;
            String normalized = value.trim()
                    .toUpperCase(Locale.ROOT)
                    .replace('-', '_')
                    .replace(' ', '_');
            if (normalized.isEmpty()) return UNKNOWN;
            if ("AD".equals(normalized) || "DESCRIPTIVE".equals(normalized)
                    || "DESCRIPTION".equals(normalized)) {
                return AUDIO_DESCRIPTION;
            }
            if ("HI".equals(normalized) || "HEARING_IMPAIRED".equals(normalized)) {
                return SDH;
            }
            try {
                return Role.valueOf(normalized);
            } catch (IllegalArgumentException ignored) {
                return UNKNOWN;
            }
        }
    }

    /** Durable user intent. A {@code null} Preference means no saved choice. */
    public static final class Preference {
        private final String stableId;
        private final String language;
        private final Role role;
        private final boolean disabled;

        private Preference(String stableId, String language, Role role, boolean disabled) {
            this.stableId = normalizeIdentifier(stableId);
            this.language = normalizeLanguage(language);
            this.role = role == null ? Role.UNKNOWN : role;
            this.disabled = disabled;
        }

        public static Preference selected(String stableId, String language, Role role) {
            return new Preference(stableId, language, role, false);
        }

        /** Explicitly disable a track type (used for subtitle Off). */
        public static Preference off() {
            return new Preference("", "", Role.UNKNOWN, true);
        }

        /**
         * Legacy "__on__" did not identify a track. Preserve the intent by
         * selecting the current/default track instead of guessing a language.
         */
        public static Preference anySelected() {
            return new Preference("", "", Role.UNKNOWN, false);
        }

        public String getStableId() {
            return stableId;
        }

        public String getLanguage() {
            return language;
        }

        public Role getRole() {
            return role;
        }

        public boolean isDisabled() {
            return disabled;
        }

        public boolean isAnySelected() {
            return !disabled && stableId.isEmpty()
                    && language.isEmpty() && role == Role.UNKNOWN;
        }

        @Override
        public boolean equals(Object value) {
            if (this == value) return true;
            if (!(value instanceof Preference)) return false;
            Preference other = (Preference) value;
            return disabled == other.disabled
                    && stableId.equals(other.stableId)
                    && language.equals(other.language)
                    && role == other.role;
        }

        @Override
        public int hashCode() {
            int result = stableId.hashCode();
            result = 31 * result + language.hashCode();
            result = 31 * result + role.hashCode();
            result = 31 * result + (disabled ? 1 : 0);
            return result;
        }
    }

    /** Track facts collected from the current Media3 track list. */
    public static final class Track {
        private final int index;
        private final String stableId;
        private final String language;
        private final Role role;
        private final boolean selectable;
        private final boolean selected;
        private final boolean defaultTrack;

        public Track(
                int index,
                String stableId,
                String language,
                Role role,
                boolean selectable,
                boolean selected,
                boolean defaultTrack
        ) {
            this.index = index;
            this.stableId = normalizeIdentifier(stableId);
            this.language = normalizeLanguage(language);
            this.role = role == null ? Role.UNKNOWN : role;
            this.selectable = selectable;
            this.selected = selected;
            this.defaultTrack = defaultTrack;
        }

        public int getIndex() {
            return index;
        }

        public String getStableId() {
            return stableId;
        }

        public String getLanguage() {
            return language;
        }

        public Role getRole() {
            return role;
        }

        public boolean isSelectable() {
            return selectable;
        }

        public boolean isSelected() {
            return selected;
        }

        public boolean isDefaultTrack() {
            return defaultTrack;
        }

        /** Converts the selected track back into durable user intent. */
        public Preference toPreference() {
            return Preference.selected(stableId, language, role);
        }
    }

    public enum MatchKind {
        OFF,
        STABLE_ID,
        LANGUAGE_AND_ROLE,
        LANGUAGE,
        ROLE,
        CURRENT,
        DEFAULT,
        FIRST_SELECTABLE,
        NONE
    }

    public static final class Resolution {
        private final Track track;
        private final MatchKind matchKind;

        private Resolution(Track track, MatchKind matchKind) {
            this.track = track;
            this.matchKind = matchKind;
        }

        public Track getTrack() {
            return track;
        }

        public int getTrackIndex() {
            return track == null ? -1 : track.getIndex();
        }

        public MatchKind getMatchKind() {
            return matchKind;
        }

        public boolean isDisabled() {
            return matchKind == MatchKind.OFF;
        }

        public boolean hasTrack() {
            return track != null;
        }
    }

    /**
     * Resolve a saved choice against a freshly-created track list.
     *
     * <p>Priority is stable identifier, language+role, language, role, then a
     * selected/default/first-selectable fallback. Unsupported tracks are never
     * returned.</p>
     */
    public static Resolution resolve(Preference preference, List<Track> tracks) {
        List<Track> selectable = selectableTracks(tracks);
        if (preference != null && preference.isDisabled()) {
            return new Resolution(null, MatchKind.OFF);
        }
        if (selectable.isEmpty()) {
            return new Resolution(null, MatchKind.NONE);
        }

        if (preference != null && !preference.getStableId().isEmpty()) {
            Track match = firstByStableId(selectable, preference.getStableId());
            if (match != null) return new Resolution(match, MatchKind.STABLE_ID);
        }

        if (preference != null
                && !preference.getLanguage().isEmpty()
                && preference.getRole() != Role.UNKNOWN) {
            Track match = firstByLanguageAndRole(
                    selectable, preference.getLanguage(), preference.getRole());
            if (match != null) return new Resolution(match, MatchKind.LANGUAGE_AND_ROLE);
        }

        if (preference != null && !preference.getLanguage().isEmpty()) {
            Track match = firstByLanguage(selectable, preference.getLanguage());
            if (match != null) return new Resolution(match, MatchKind.LANGUAGE);
        }

        if (preference != null && preference.getRole() != Role.UNKNOWN) {
            Track match = firstByRole(selectable, preference.getRole());
            if (match != null) return new Resolution(match, MatchKind.ROLE);
        }

        Track current = firstCurrent(selectable);
        if (current != null) return new Resolution(current, MatchKind.CURRENT);
        Track defaultTrack = firstDefault(selectable);
        if (defaultTrack != null) return new Resolution(defaultTrack, MatchKind.DEFAULT);
        return new Resolution(selectable.get(0), MatchKind.FIRST_SELECTABLE);
    }

    /**
     * Deterministic local fallback when the server/provider supplies no track
     * identifier. Do not include a volatile manifest index.
     */
    public static String fallbackStableId(
            String kind,
            String language,
            Role role,
            String codec,
            int channels
    ) {
        return normalizeIdentifier(kind) + ":"
                + normalizeLanguage(language) + ":"
                + (role == null ? Role.UNKNOWN : role).name().toLowerCase(Locale.ROOT) + ":"
                + normalizeIdentifier(codec) + ":"
                + Math.max(0, channels);
    }

    public static String normalizeLanguage(String value) {
        if (value == null) return "";
        String normalized = value.trim().toLowerCase(Locale.ROOT).replace('_', '-');
        if (normalized.isEmpty() || "und".equals(normalized)
                || "unknown".equals(normalized) || "null".equals(normalized)) {
            return "";
        }
        String[] parts = normalized.split("-", 2);
        String base = parts[0];
        String alias = LANGUAGE_ALIASES.get(base);
        if (alias != null) {
            normalized = alias + (parts.length > 1 ? "-" + parts[1] : "");
        }
        return normalized;
    }

    private static String normalizeIdentifier(String value) {
        return value == null ? "" : value.trim();
    }

    private static List<Track> selectableTracks(List<Track> tracks) {
        if (tracks == null || tracks.isEmpty()) return Collections.emptyList();
        List<Track> result = new ArrayList<>();
        for (Track track : tracks) {
            if (track != null && track.isSelectable()) result.add(track);
        }
        return result;
    }

    private static Track firstByStableId(List<Track> tracks, String id) {
        for (Track track : tracks) {
            if (!track.getStableId().isEmpty() && track.getStableId().equals(id)) return track;
        }
        return null;
    }

    private static Track firstByLanguageAndRole(
            List<Track> tracks, String language, Role role) {
        for (Track track : tracks) {
            if (sameLanguage(track.getLanguage(), language) && track.getRole() == role) return track;
        }
        return null;
    }

    private static Track firstByLanguage(List<Track> tracks, String language) {
        for (Track track : tracks) {
            if (sameLanguage(track.getLanguage(), language)) return track;
        }
        return null;
    }

    private static Track firstByRole(List<Track> tracks, Role role) {
        for (Track track : tracks) {
            if (track.getRole() == role) return track;
        }
        return null;
    }

    private static Track firstCurrent(List<Track> tracks) {
        for (Track track : tracks) {
            if (track.isSelected()) return track;
        }
        return null;
    }

    private static Track firstDefault(List<Track> tracks) {
        for (Track track : tracks) {
            if (track.isDefaultTrack()) return track;
        }
        return null;
    }

    private static boolean sameLanguage(String left, String right) {
        String a = normalizeLanguage(left);
        String b = normalizeLanguage(right);
        if (a.equals(b)) return true;
        if (a.isEmpty() || b.isEmpty()) return false;
        return baseLanguage(a).equals(baseLanguage(b));
    }

    private static String baseLanguage(String language) {
        int dash = language.indexOf('-');
        return dash < 0 ? language : language.substring(0, dash);
    }

    private static final Map<String, String> LANGUAGE_ALIASES;

    static {
        Map<String, String> aliases = new HashMap<>();
        aliases.put("eng", "en");
        aliases.put("fra", "fr");
        aliases.put("fre", "fr");
        aliases.put("spa", "es");
        aliases.put("deu", "de");
        aliases.put("ger", "de");
        aliases.put("ita", "it");
        aliases.put("por", "pt");
        aliases.put("ara", "ar");
        aliases.put("tur", "tr");
        aliases.put("rus", "ru");
        aliases.put("nld", "nl");
        aliases.put("dut", "nl");
        aliases.put("hin", "hi");
        aliases.put("jpn", "ja");
        aliases.put("kor", "ko");
        aliases.put("zho", "zh");
        aliases.put("chi", "zh");
        LANGUAGE_ALIASES = Collections.unmodifiableMap(aliases);
    }
}
