// Runtime proof for the only cross-process crash gap: the first Deno worker is
// killed after the gateway has accepted its opaque stop, but before it can call
// the durable settle RPC. A second worker must re-run the idempotent stop under
// a newer lease/revision and settle exactly once. No production endpoint, key,
// provider URL, or Supabase project is used here.
const userId = "d0000000-0000-0000-0000-000000000098";
const affinityHash = "f".repeat(64);

function requireEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function body(req: Request) {
  return await req.json().catch(() => ({})) as Record<string, unknown>;
}

Deno.test({ name: "transport stop survives a real Deno process death after gateway and before settle", sanitizeOps: false, sanitizeResources: false }, async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "norva-transport-crash-" });
  const source = await Deno.readTextFile(new URL("../functions/norva-account-delete/index.ts", import.meta.url));
  // Import the exact source in a child Deno process, exporting only the tested
  // internal routine and neutralising the top-level HTTP listener for the test.
  const runtimeModule = `${tempDir}/account-delete-runtime.ts`;
  await Deno.writeTextFile(runtimeModule, source
    .replace("async function drainProviderTransportStop", "export async function drainProviderTransportStop")
    .replace("Deno.serve(async (req) => {", "void (async (req) => {"));
  const childModule = `${tempDir}/worker.ts`;
  await Deno.writeTextFile(childModule, `
    const runtime = await import(Deno.env.get("NORVA_RUNTIME_MODULE")!);
    const dbUrl = Deno.env.get("NORVA_TEST_DB_URL")!;
    const db = { rpc: async (name: string, args: unknown) => {
      const response = await fetch(dbUrl + "/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
      return await response.json();
    }};
    const result = await runtime.drainProviderTransportStop(db, "${userId}");
    await fetch(dbUrl + "/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result }) });
  `);

  let phase: "first" | "recovery" = "first";
  let gatewayCalls = 0;
  let settleCalls = 0;
  let observedResult = "";
  let gatewayHit!: () => void;
  const gatewayHitPromise = new Promise<void>((resolve) => { gatewayHit = resolve; });
  const gateway = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (req) => {
    requireEqual(req.method, "POST", "gateway method");
    requireEqual(new URL(req.url).pathname, "/sessions/stop-provider-affinities", "gateway path");
    requireEqual(req.headers.get("authorization"), "Bearer test-gateway-token", "gateway authorization");
    const request = await body(req);
    const hashes = request.affinityHashes as string[];
    requireEqual(Array.isArray(hashes), true, "gateway opaque hash array");
    requireEqual(hashes[0], affinityHash, "gateway opaque hash");
    gatewayCalls++;
    if (phase === "first") gatewayHit();
    return Response.json({ providerDrained: true, protocol: 1 });
  });
  const gatewayPort = (gateway.addr as Deno.NetAddr).port;
  const db = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/result") {
      observedResult = String((await body(req)).result ?? "");
      return Response.json({ ok: true });
    }
    const request = await body(req);
    const name = String(request.name ?? "");
    const args = (request.args ?? {}) as Record<string, unknown>;
    const leaseSequence = phase === "first" ? 1 : 2;
    const revision = phase === "first" ? 1 : 2;
    if (name === "norva_claim_account_deletion_transport_stop") {
      return Response.json({ data: { state: "processing", deletionEpoch: 9, leaseSequence, revision }, error: null });
    }
    if (name === "norva_revalidate_account_deletion_transport_stop") {
      requireEqual(args.p_expected_lease_sequence, leaseSequence, "revalidation lease");
      requireEqual(args.p_expected_revision, revision, "revalidation revision");
      return Response.json({ data: { state: "processing", deletionEpoch: 9, leaseSequence, revision, affinityHashes: [affinityHash] }, error: null });
    }
    if (name === "norva_settle_provider_transport_stop_action") {
      requireEqual(args.p_expected_lease_sequence, 2, "settle must use recovered lease");
      requireEqual(args.p_expected_revision, 2, "settle must use recovered revision");
      settleCalls++;
      return Response.json({ data: null, error: null });
    }
    throw new Error(`unexpected RPC ${name}`);
  });
  const dbPort = (db.addr as Deno.NetAddr).port;
  const env = {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    NORVA_MEDIA_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    NORVA_MEDIA_GATEWAY_TOKEN: "test-gateway-token",
    NORVA_RUNTIME_MODULE: new URL(`file:///${runtimeModule.replace(/\\/g, "/")}`).href,
    NORVA_TEST_DB_URL: `http://127.0.0.1:${dbPort}`,
  };
  const command = () => new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-env", "--allow-net", `--allow-read=${tempDir}`, childModule], env,
    stdout: "piped", stderr: "piped",
  });
  try {
    const first = command().spawn();
    const firstStderr = new Response(first.stderr).text();
    try {
      await Promise.race([
        gatewayHitPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("first worker never reached gateway")), 10_000)),
      ]);
    } catch (error) {
      try { first.kill("SIGKILL"); } catch { /* child may already have exited */ }
      await first.status;
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${await firstStderr}`);
    }
    first.kill("SIGKILL");
    const firstStatus = await first.status;
    await firstStderr;
    requireEqual(firstStatus.success, false, "first worker must be killed");
    requireEqual(gatewayCalls, 1, "first gateway stop");
    requireEqual(settleCalls, 0, "killed worker must not settle");

    phase = "recovery";
    const recovered = await command().output();
    if (!recovered.success) {
      throw new Error(`recovered worker failed: ${new TextDecoder().decode(recovered.stderr)}`);
    }
    requireEqual(gatewayCalls, 2, "recovery must retry idempotent gateway stop");
    requireEqual(settleCalls, 1, "only recovered worker settles");
    requireEqual(observedResult, "completed", "recovered worker result");
  } finally {
    gateway.shutdown();
    db.shutdown();
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
});
