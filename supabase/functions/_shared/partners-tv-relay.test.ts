import {
  loadTvRelayConfig,
  PARTNERS_TV_RELAY_HANDOFF_URL,
} from "./partners-tv-relay.ts";

const SECRET = "s".repeat(32);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function loadWith(handoffUrl: string) {
  const values: Record<string, string> = {
    NORVA_PARTNERS_TV_RELAY_SECRET: SECRET,
    NORVA_PARTNERS_TV_RELAY_HANDOFF_URL: handoffUrl,
    NORVA_PARTNERS_TV_RELAY_TTL_SECONDS: "300",
  };
  return loadTvRelayConfig((name) => values[name]);
}

Deno.test("TV relay accepts only the canonical Android TV handoff", () => {
  const config = loadWith(PARTNERS_TV_RELAY_HANDOFF_URL);
  assert(config !== null, "canonical handoff must configure the relay");
  assert(
    config.handoffUrl === "https://norva.tv/app.html",
    "canonical handoff must be preserved exactly",
  );
});

Deno.test("TV relay fails closed on every handoff path or origin drift", () => {
  for (
    const candidate of [
      "https://norva.tv/app",
      "https://norva.tv/app/",
      "https://www.norva.tv/app.html",
      "https://partners.norva.tv/app.html",
      "https://norva.tv:443/app.html",
      "https://norva.tv/app.html?mobile=1",
      "https://norva.tv/app.html#partners",
      "http://norva.tv/app.html",
      " https://norva.tv/app.html",
    ]
  ) {
    assert(loadWith(candidate) === null, `${candidate} must fail closed`);
  }
});
