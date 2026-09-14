// A read-only 90-second Worker tail. Raw events never reach disk or CI logs:
// request URLs, headers, tokens, user identifiers, messages and stacks are omitted.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function exceptionCategory(value) {
  const message = String(value || '');
  if (/cpu|exceeded.*time/i.test(message)) return 'cpu-limit';
  if (/memory limit|out of memory/i.test(message)) return 'memory-limit';
  if (/different request|different durable object|io.?context/i.test(message)) return 'io-context';
  if (/content.?length|fixedlength|too (?:many|few) bytes|length mismatch/i.test(message)) return 'stream-length';
  if (/PLAYBACK_SUPERSEDED/i.test(message)) return 'session-revoked';
  if (/cancel|abort/i.test(message)) return 'cancelled';
  if (/network|connection|socket|fetch failed|disconnected|quic/i.test(message)) return 'transport';
  return 'unclassified';
}

export function sanitizeEvent(raw) {
  const outcomes = new Set(['ok', 'exception', 'canceled', 'exceededCpu', 'exceededMemory', 'unknown']);
  const result = { outcome: outcomes.has(raw?.outcome) ? raw.outcome : 'unknown' };
  const timestamp = Number(raw?.eventTimestamp);
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 1e14) result.at = new Date(timestamp).toISOString();
  for (const key of ['cpuTime', 'wallTime']) {
    const value = raw?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e9) result[key] = value;
  }
  result.exceptions = (Array.isArray(raw?.exceptions) ? raw.exceptions : []).slice(0, 5)
    .map(error => exceptionCategory(error?.message));
  const allowedTags = new Set(['norva-relay-range-resumed', 'norva-relay-upstream-error', 'norva-relay-socket-fallback-error']);
  result.signals = [];
  for (const log of (Array.isArray(raw?.logs) ? raw.logs : []).slice(0, 100)) {
    for (const part of (Array.isArray(log?.message) ? log.message : []).slice(0, 10)) {
      let value = part;
      if (typeof part === 'string') { try { value = JSON.parse(part); } catch { continue; } }
      if (!allowedTags.has(value?.tag)) continue;
      const signal = { tag: value.tag };
      if ([1, 2].includes(value.attempt)) signal.attempt = value.attempt;
      if (['timeout', 'interrupted'].includes(value.reason)) signal.reason = value.reason;
      if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) signal.status = value.status;
      if (value.error) signal.errorCategory = exceptionCategory(value.error);
      result.signals.push(signal);
    }
  }
  return result;
}

export function jsonObjectReader(consume) {
  let buffer = '', depth = 0, quoted = false, escaped = false;
  return chunk => {
    for (const char of chunk) {
      if (depth === 0) {
        if (char !== '{') continue;
        buffer = '{'; depth = 1; quoted = false; escaped = false; continue;
      }
      buffer += char;
      if (buffer.length > 2_000_000) throw new Error('diagnostic-event-too-large');
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { consume(JSON.parse(buffer)); } catch { /* Fail closed: never print raw JSON. */ }
        buffer = '';
      }
    }
  };
}

async function main() {
  // Read only: identify the existing execution model/limit without changing
  // billing, limits or the deployed Worker. Never print the settings payload.
  try {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!/^[a-f0-9]{32}$/i.test(account || '')) throw new Error('unavailable');
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/norva-relay/settings`, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json(), settings = data?.result;
    const out = { diagnostic: 'runtime-settings', available: response.ok && data?.success === true };
    if (['standard', 'bundled', 'unbound'].includes(settings?.usage_model)) out.usageModel = settings.usage_model;
    if (Number.isFinite(settings?.limits?.cpu_ms)) out.cpuLimitMs = settings.limits.cpu_ms;
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch { process.stdout.write(JSON.stringify({ diagnostic: 'runtime-settings', available: false }) + '\n'); }
  const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'),
    'tail', 'norva-relay', '--format', 'json',
    '--config', 'services/norva-relay/wrangler.jsonc'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const summary = { events: 0, outcomes: {}, exceptions: {}, signals: {}, timedOut: false, authIssue: false, configurationError: false };
  const inspectSetup = chunk => {
    if (/authentication error|not authenticated|unauthorized|necessary to set a CLOUDFLARE_API_TOKEN|code:\s*(?:10000|9109)/i.test(chunk)) summary.authIssue = true;
    if (/sampling rate must|unknown argument|cannot find module|MODULE_NOT_FOUND/i.test(chunk)) summary.configurationError = true;
  };
  const write = value => process.stdout.write(JSON.stringify(value) + '\n');
  const consume = jsonObjectReader(raw => {
    if (!raw || !('outcome' in raw)) return;
    const event = sanitizeEvent(raw);
    summary.events++;
    summary.outcomes[event.outcome] = (summary.outcomes[event.outcome] || 0) + 1;
    for (const key of event.exceptions) summary.exceptions[key] = (summary.exceptions[key] || 0) + 1;
    for (const signal of event.signals) summary.signals[signal.tag] = (summary.signals[signal.tag] || 0) + 1;
    if (summary.events <= 150 && (event.outcome !== 'ok' || event.exceptions.length || event.signals.length)) write(event);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    inspectSetup(chunk);
    try { consume(chunk); } catch { child.kill('SIGTERM'); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', inspectSetup);
  child.on('error', () => { write({ diagnostic: 'spawn-failed' }); process.exitCode = 1; });
  write({ diagnostic: 'starting', seconds: 90, productionConfigurationChanged: false });
  let hardStop;
  const timer = setTimeout(() => {
    summary.timedOut = true; child.kill('SIGINT');
    hardStop = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, 90_000);
  child.on('close', code => {
    clearTimeout(timer); clearTimeout(hardStop);
    write({ diagnostic: 'finished', ...summary });
    if (!summary.events || summary.authIssue || (code && !summary.timedOut)) process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
