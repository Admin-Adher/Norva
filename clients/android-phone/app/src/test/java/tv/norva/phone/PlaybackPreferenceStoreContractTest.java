package tv.norva.phone;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Dependency-free contract test. It can run with a plain JDK:
 *
 * <pre>
 * javac -d build/test-classes TrackSelectionResolver.java
 *       PlaybackPreferenceStore.java PlaybackPreferenceStoreContractTest.java
 * java -ea -cp build/test-classes tv.norva.phone.PlaybackPreferenceStoreContractTest
 * </pre>
 *
 * Kept free of Android and JUnit so preference semantics can be checked without
 * an emulator or an additional Gradle dependency.
 */
public final class PlaybackPreferenceStoreContractTest {

    private PlaybackPreferenceStoreContractTest() {}

    public static void main(String[] args) {
        precedenceIsFieldByField();
        accountProfileSourceAndVersionAreIsolated();
        legacySubtitleMigrationIsOneShot();
        resolverUsesStableFactsAndNeverUnsupportedTracks();
        serializationRoundTripsOpaqueIdentifiers();
    }

    private static void precedenceIsFieldByField() {
        MemoryBackend backend = new MemoryBackend();
        PlaybackPreferenceStore store = new PlaybackPreferenceStore(backend);
        PlaybackPreferenceStore.Scope scope = scope(
                "account-a", "profile-a", "source-a", "version-a", "movie-a", "series-a");

        TrackSelectionResolver.Preference profileAudio = pref(
                "profile-audio", "en", TrackSelectionResolver.Role.MAIN);
        TrackSelectionResolver.Preference profileSubtitle = pref(
                "profile-sub", "en", TrackSelectionResolver.Role.FULL);
        TrackSelectionResolver.Preference seriesAudio = pref(
                "series-audio", "fr", TrackSelectionResolver.Role.DUB);
        TrackSelectionResolver.Preference exactSubtitle = pref(
                "exact-sub", "fr", TrackSelectionResolver.Role.SDH);

        check(store.saveProfile(
                scope, new PlaybackPreferenceStore.Preferences(profileAudio, profileSubtitle)));
        check(store.saveSeriesAudio(scope, seriesAudio));
        check(store.saveExactSubtitle(scope, exactSubtitle));

        PlaybackPreferenceStore.Preferences resolved = store.resolve(
                scope,
                new PlaybackPreferenceStore.Preferences(
                        pref("default", "de", TrackSelectionResolver.Role.MAIN),
                        TrackSelectionResolver.Preference.off()));
        equal(seriesAudio, resolved.getAudio());
        equal(exactSubtitle, resolved.getSubtitle());
    }

    private static void accountProfileSourceAndVersionAreIsolated() {
        MemoryBackend backend = new MemoryBackend();
        PlaybackPreferenceStore store = new PlaybackPreferenceStore(backend);
        PlaybackPreferenceStore.Scope base = scope(
                "account-a", "profile-a", "source-a", "version-a", "movie-a", "series-a");
        TrackSelectionResolver.Preference french = pref(
                "audio-fr", "fr", TrackSelectionResolver.Role.DUB);
        check(store.saveExactAudio(base, french));

        equal(french, store.resolve(base, null).getAudio());
        noAudio(store, scope(
                "account-b", "profile-a", "source-a", "version-a", "movie-a", "series-a"));
        noAudio(store, scope(
                "account-a", "profile-b", "source-a", "version-a", "movie-a", "series-a"));
        noAudio(store, scope(
                "account-a", "profile-a", "source-b", "version-a", "movie-a", "series-a"));
        noAudio(store, scope(
                "account-a", "profile-a", "source-a", "version-b", "movie-a", "series-a"));
        noAudio(store, scope(
                "account-a", "profile-a", "source-a", "version-a", "movie-b", "series-a"));
    }

    private static void legacySubtitleMigrationIsOneShot() {
        MemoryBackend backend = new MemoryBackend();
        PlaybackPreferenceStore store = new PlaybackPreferenceStore(backend);

        PlaybackPreferenceStore.Scope offScope = scope(
                "a", "p", "s", "v-off", "item-off", "series");
        check(store.migrateLegacySubtitle(offScope, "__off__"));
        check(store.resolve(offScope, null).getSubtitle().isDisabled());
        check(!store.migrateLegacySubtitle(offScope, "fr"));
        check(store.resolve(offScope, null).getSubtitle().isDisabled());

        PlaybackPreferenceStore.Scope onScope = scope(
                "a", "p", "s", "v-on", "item-on", "series");
        check(store.migrateLegacySubtitle(onScope, "__on__"));
        check(store.resolve(onScope, null).getSubtitle().isAnySelected());

        PlaybackPreferenceStore.Scope languageScope = scope(
                "a", "p", "s", "v-fr", "item-fr", "series");
        check(store.migrateLegacySubtitle(languageScope, "fre"));
        equal("fr", store.resolve(languageScope, null).getSubtitle().getLanguage());
        equal("episode:item-fr",
                PlaybackPreferenceStore.legacySubtitleKey("episode", "item-fr"));
    }

    private static void resolverUsesStableFactsAndNeverUnsupportedTracks() {
        TrackSelectionResolver.Track unsupportedExact = new TrackSelectionResolver.Track(
                0, "exact", "fr", TrackSelectionResolver.Role.DUB, false, false, false);
        TrackSelectionResolver.Track currentEnglish = new TrackSelectionResolver.Track(
                1, "english", "eng-US", TrackSelectionResolver.Role.MAIN, true, true, false);
        TrackSelectionResolver.Track frenchDub = new TrackSelectionResolver.Track(
                2, "french", "fra", TrackSelectionResolver.Role.DUB, true, false, true);

        TrackSelectionResolver.Resolution byId = TrackSelectionResolver.resolve(
                pref("french", "en", TrackSelectionResolver.Role.MAIN),
                Arrays.asList(unsupportedExact, currentEnglish, frenchDub));
        equal(TrackSelectionResolver.MatchKind.STABLE_ID, byId.getMatchKind());
        equal(2, byId.getTrackIndex());

        TrackSelectionResolver.Resolution byLanguageRole = TrackSelectionResolver.resolve(
                pref("", "fr-FR", TrackSelectionResolver.Role.DUB),
                Arrays.asList(unsupportedExact, currentEnglish, frenchDub));
        equal(TrackSelectionResolver.MatchKind.LANGUAGE_AND_ROLE,
                byLanguageRole.getMatchKind());
        equal(2, byLanguageRole.getTrackIndex());

        TrackSelectionResolver.Resolution unavailable = TrackSelectionResolver.resolve(
                pref("", "ja", TrackSelectionResolver.Role.MAIN),
                Arrays.asList(unsupportedExact, currentEnglish, frenchDub));
        equal(TrackSelectionResolver.MatchKind.ROLE, unavailable.getMatchKind());
        equal(1, unavailable.getTrackIndex());

        TrackSelectionResolver.Resolution off = TrackSelectionResolver.resolve(
                TrackSelectionResolver.Preference.off(),
                Arrays.asList(currentEnglish, frenchDub));
        check(off.isDisabled());
        equal(-1, off.getTrackIndex());
    }

    private static void serializationRoundTripsOpaqueIdentifiers() {
        MemoryBackend backend = new MemoryBackend();
        PlaybackPreferenceStore store = new PlaybackPreferenceStore(backend);
        PlaybackPreferenceStore.Scope scope = scope(
                "email+tag@example.test", "profile|1", "source,1",
                "version%1", "item with spaces", "series/1");
        TrackSelectionResolver.Preference preference = pref(
                "audio|id,with%delimiters", "pt_BR", TrackSelectionResolver.Role.ORIGINAL);
        check(store.saveExactAudio(scope, preference));
        equal(preference, store.resolve(scope, null).getAudio());
    }

    private static PlaybackPreferenceStore.Scope scope(
            String account,
            String profile,
            String source,
            String version,
            String item,
            String series
    ) {
        return PlaybackPreferenceStore.Scope.builder()
                .accountId(account)
                .profileId(profile)
                .sourceId(source)
                .versionKey(version)
                .itemType("episode")
                .itemId(item)
                .seriesId(series)
                .build();
    }

    private static TrackSelectionResolver.Preference pref(
            String id, String language, TrackSelectionResolver.Role role) {
        return TrackSelectionResolver.Preference.selected(id, language, role);
    }

    private static void noAudio(
            PlaybackPreferenceStore store, PlaybackPreferenceStore.Scope scope) {
        equal(null, store.resolve(scope, null).getAudio());
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError();
    }

    private static void equal(Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("Expected " + expected + " but got " + actual);
        }
    }

    private static final class MemoryBackend implements PlaybackPreferenceStore.Backend {
        private final Map<String, String> values = new HashMap<>();

        @Override
        public String get(String key) {
            return values.get(key);
        }

        @Override
        public void put(String key, String value) {
            values.put(key, value);
        }

        @Override
        public void remove(String key) {
            values.remove(key);
        }
    }
}
