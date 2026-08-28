package tv.norva.phone;

import java.util.Arrays;
import java.util.List;

/**
 * Dependency-free contract checks for the native player's P0 state model and
 * real-first-frame fixture evidence.
 *
 * <p>This is intentionally a plain Java main instead of a mocked ExoPlayer
 * test: a mocked callback must never be reported as successful playback. The
 * separate debug broadcast contract in PlayerActivity is consumed by emulator
 * instrumentation with a real, known-good H.264/AAC fixture.</p>
 */
public final class PlayerActivityPlaybackUiContractTest {

    private PlayerActivityPlaybackUiContractTest() {}

    public static void main(String[] args) {
        declaresEveryExclusiveState();
        controllersAreGatedToPostFirstFrameStates();
        bufferingAndReadyTransitionsStayHonest();
        firstFrameIsBoundToTheActiveRoute();
        backgroundPlaybackRequiresForegroundOrPip();
        formatRecoveryClassificationIsDeterministic();
        knownGoodFixtureRequiresRealExactCodecEvidence();
        episodeNavigationInputsAreBounded();
    }

    private static void declaresEveryExclusiveState() {
        List<String> expected = Arrays.asList(
                "PREPARING",
                "INITIAL_BUFFERING",
                "RECOVERING",
                "PLAYING",
                "REBUFFERING",
                "TERMINAL",
                "OFFLINE");
        String[] actual = Arrays.stream(PlayerActivity.PlaybackUiState.values())
                .map(Enum::name)
                .toArray(String[]::new);
        equal(expected, Arrays.asList(actual));
    }

    private static void controllersAreGatedToPostFirstFrameStates() {
        for (PlayerActivity.PlaybackUiState state : PlayerActivity.PlaybackUiState.values()) {
            boolean expected = state == PlayerActivity.PlaybackUiState.PLAYING
                    || state == PlayerActivity.PlaybackUiState.REBUFFERING;
            equal(expected, PlayerActivity.isControllerState(state));
        }
    }

    private static void bufferingAndReadyTransitionsStayHonest() {
        equal(
                PlayerActivity.PlaybackUiState.INITIAL_BUFFERING,
                PlayerActivity.stateForBuffering(false, false));
        equal(
                PlayerActivity.PlaybackUiState.REBUFFERING,
                PlayerActivity.stateForBuffering(false, true));
        equal(
                PlayerActivity.PlaybackUiState.RECOVERING,
                PlayerActivity.stateForBuffering(true, true));

        // Media3 READY without a rendered frame must not expose PLAYING.
        equal(
                PlayerActivity.PlaybackUiState.INITIAL_BUFFERING,
                PlayerActivity.stateAfterReady(false, false));
        equal(
                PlayerActivity.PlaybackUiState.RECOVERING,
                PlayerActivity.stateAfterReady(true, false));
        equal(
                PlayerActivity.PlaybackUiState.PLAYING,
                PlayerActivity.stateAfterReady(false, true));
        equal(
                PlayerActivity.PlaybackUiState.PLAYING,
                PlayerActivity.stateAfterReady(true, true));
    }

    private static void formatRecoveryClassificationIsDeterministic() {
        check(PlayerActivity.isFormatRecoveryReason(
                "ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED"));
        check(PlayerActivity.isFormatRecoveryReason(
                "ERROR_CODE_DECODING_FORMAT_UNSUPPORTED"));
        check(!PlayerActivity.isFormatRecoveryReason(
                "ERROR_CODE_PARSING_CONTAINER_MALFORMED"));
        check(!PlayerActivity.isFormatRecoveryReason("no_data_timeout"));
        check(!PlayerActivity.isFormatRecoveryReason(null));
    }

    private static void firstFrameIsBoundToTheActiveRoute() {
        check(PlayerActivity.isFirstFrameForActiveRoute(
                "norva-route-2",
                "norva-route-2",
                "norva-route-2"));
        check(!PlayerActivity.isFirstFrameForActiveRoute(
                "norva-route-1",
                "norva-route-2",
                "norva-route-2"));
        check(!PlayerActivity.isFirstFrameForActiveRoute(
                "norva-route-2",
                "norva-route-2",
                "norva-route-1"));
        check(!PlayerActivity.isFirstFrameForActiveRoute(null, "norva-route-2", "norva-route-2"));
    }

    private static void backgroundPlaybackRequiresForegroundOrPip() {
        check(PlayerActivity.shouldAllowPlayback(true, false));
        check(PlayerActivity.shouldAllowPlayback(false, true));
        check(!PlayerActivity.shouldAllowPlayback(false, false));
    }

    private static void knownGoodFixtureRequiresRealExactCodecEvidence() {
        check(PlayerActivity.isKnownGoodH264AacFirstFrameEvidence(
                true,
                PlayerActivity.FIRST_FRAME_FIXTURE_VIDEO_MIME,
                PlayerActivity.FIRST_FRAME_FIXTURE_AUDIO_MIME));
        check(!PlayerActivity.isKnownGoodH264AacFirstFrameEvidence(
                false,
                PlayerActivity.FIRST_FRAME_FIXTURE_VIDEO_MIME,
                PlayerActivity.FIRST_FRAME_FIXTURE_AUDIO_MIME));
        check(!PlayerActivity.isKnownGoodH264AacFirstFrameEvidence(
                true,
                "video/hevc",
                PlayerActivity.FIRST_FRAME_FIXTURE_AUDIO_MIME));
        check(!PlayerActivity.isKnownGoodH264AacFirstFrameEvidence(
                true,
                PlayerActivity.FIRST_FRAME_FIXTURE_VIDEO_MIME,
                "audio/ac3"));
        check(!PlayerActivity.isKnownGoodH264AacFirstFrameEvidence(
                true,
                "",
                ""));
    }

    private static void episodeNavigationInputsAreBounded() {
        equal(
                PlayerActivity.EPISODE_NAVIGATION_PREVIOUS,
                PlayerActivity.boundedEpisodeNavigationDirection("previous"));
        equal(
                PlayerActivity.EPISODE_NAVIGATION_NEXT,
                PlayerActivity.boundedEpisodeNavigationDirection("next"));
        equal(null, PlayerActivity.boundedEpisodeNavigationDirection("restart"));
        equal(null, PlayerActivity.boundedEpisodeNavigationDirection(null));
        equal("S4 E2 - Next episode",
                PlayerActivity.boundedEpisodeLabel("  S4 E2 - Next\nepisode  "));
        equal(null, PlayerActivity.boundedEpisodeLabel("   "));
        String oversized = "x".repeat(300);
        equal(180, PlayerActivity.boundedEpisodeLabel(oversized).length());
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError();
    }

    private static void equal(Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("Expected " + expected + " but got " + actual);
        }
    }
}
