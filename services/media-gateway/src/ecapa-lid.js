'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_MAX_WAV_BYTES = 64 * 1024 * 1024;
const LANGUAGE_RE = /^[a-z]{2,3}$/;

class EcapaLidError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'EcapaLidError';
    this.code = code;
    this.retryable = retryable;
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function cleanText(value, fallback = 'ECAPA worker failed') {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return text || fallback;
}

function finiteNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

function canonicalLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (language === 'iw') return 'he';
  if (language === 'jw') return 'jv';
  return LANGUAGE_RE.test(language) ? language : null;
}

async function validateWavPath(wavPath, {
  allowedRoot,
  maxWavBytes = DEFAULT_MAX_WAV_BYTES,
  fsPromises = fsp,
} = {}) {
  if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
    throw new EcapaLidError(
      'CONFIG_ERROR',
      'ECAPA allowed WAV root must be an absolute path',
    );
  }
  if (typeof wavPath !== 'string' || !path.isAbsolute(wavPath) || wavPath.length > 4096) {
    throw new EcapaLidError('INVALID_WAV', 'WAV path must be an absolute bounded path');
  }
  if (path.extname(wavPath).toLowerCase() !== '.wav') {
    throw new EcapaLidError('INVALID_WAV', 'Only WAV input is accepted');
  }

  let rootReal;
  let requestedStat;
  let wavReal;
  let wavStat;
  try {
    rootReal = await fsPromises.realpath(path.resolve(allowedRoot));
    const requested = path.resolve(wavPath);
    requestedStat = await fsPromises.lstat(requested);
    if (requestedStat.isSymbolicLink()) {
      throw new EcapaLidError('INVALID_WAV', 'Symbolic-link WAV input is not accepted');
    }
    wavReal = await fsPromises.realpath(requested);
    wavStat = await fsPromises.stat(wavReal);
  } catch (error) {
    if (error instanceof EcapaLidError) throw error;
    throw new EcapaLidError('INVALID_WAV', 'WAV input is unavailable');
  }

  if (!isWithinRoot(rootReal, wavReal)) {
    throw new EcapaLidError('INVALID_WAV', 'WAV input is outside the allowed root');
  }
  if (!wavStat.isFile() || path.extname(wavReal).toLowerCase() !== '.wav') {
    throw new EcapaLidError('INVALID_WAV', 'WAV input must be a regular WAV file');
  }
  const boundedMax = clampInt(maxWavBytes, DEFAULT_MAX_WAV_BYTES, 4096, 512 * 1024 * 1024);
  if (wavStat.size < 44 || wavStat.size > boundedMax) {
    throw new EcapaLidError('INVALID_WAV', 'WAV input size is outside the allowed bounds');
  }
  return { path: wavReal, bytes: wavStat.size };
}

function normalizeTopEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const rawLanguage = String(value.rawLanguage || value.language || '').trim().toLowerCase();
  const language = canonicalLanguage(value.language || rawLanguage);
  const probability = finiteNumber(value.probability, 0, 1);
  const logPosterior = finiteNumber(value.logPosterior, -1_000_000, 0);
  if (!language || probability === null || logPosterior === null) return null;
  return {
    language,
    rawLanguage: LANGUAGE_RE.test(rawLanguage) ? rawLanguage : language,
    label: cleanText(value.label, language),
    probability,
    logPosterior,
  };
}

function normalizeWorkerResult(payload, item) {
  if (!payload || payload.ok !== true || !payload.result || typeof payload.result !== 'object') {
    const workerError = payload && typeof payload.error === 'object' ? payload.error : {};
    const code = /^[A-Z][A-Z0-9_]{1,39}$/.test(String(workerError.code || ''))
      ? workerError.code
      : 'WORKER_FAILED';
    throw new EcapaLidError(
      code,
      cleanText(workerError.message),
      code === 'INFERENCE_FAILED',
    );
  }

  const result = payload.result;
  const rawLanguage = String(result.rawLanguage || result.candidateLanguage || '')
    .trim().toLowerCase();
  const candidateLanguage = canonicalLanguage(result.candidateLanguage || rawLanguage);
  const probability = finiteNumber(result.probability, 0, 1);
  const logPosterior = finiteNumber(result.logPosterior, -1_000_000, 0);
  const margin = finiteNumber(result.margin, 0, 1_000_000);
  const entropy = finiteNumber(result.entropy, 0, 100);
  const top = Array.isArray(result.top)
    ? result.top.slice(0, 2).map(normalizeTopEntry)
    : [];
  if (
    !candidateLanguage ||
    probability === null ||
    logPosterior === null ||
    margin === null ||
    entropy === null ||
    top.length !== 2 ||
    top.some((entry) => !entry) ||
    top[0].language !== candidateLanguage
  ) {
    throw new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker returned an invalid result');
  }

  const metrics = result.metrics && typeof result.metrics === 'object'
    ? result.metrics
    : {};
  const inferenceMs = finiteNumber(metrics.inferenceMs, 0, 3_600_000);
  const cpuMs = finiteNumber(metrics.cpuMs, 0, 3_600_000);
  const rssKb = finiteNumber(metrics.rssKb, 0, 1024 * 1024 * 1024);
  if (inferenceMs === null || cpuMs === null || rssKb === null) {
    throw new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker returned invalid metrics');
  }

  const bridgeTotalMs = Math.round((performance.now() - item.startedAt) * 100) / 100;
  const bridgeQueueMs = Math.round((item.sentAt - item.enqueuedAt) * 100) / 100;
  return {
    ok: true,
    candidateLanguage,
    rawLanguage: LANGUAGE_RE.test(rawLanguage) ? rawLanguage : candidateLanguage,
    label: cleanText(result.label, candidateLanguage),
    probability,
    logPosterior,
    top,
    margin,
    entropy,
    metrics: {
      inferenceMs,
      cpuMs,
      rssKb,
      bridgeQueueMs,
      bridgeTotalMs,
    },
    sample: {
      wavBytes: item.wavBytes,
    },
    // This is raw benchmark evidence only. Acceptance/verification belongs to the
    // caller after calibration against independently labelled Norva audio.
    accepted: false,
    verified: false,
  };
}

class EcapaLidWorker {
  constructor({
    pythonBin = process.env.ECAPA_PYTHON_BIN || '/opt/ecapa-venv/bin/python3',
    scriptPath = path.join(__dirname, 'ecapa_lid_worker.py'),
    modelDir = process.env.ECAPA_MODEL_DIR || '/opt/ecapa-model',
    modelRevision = process.env.ECAPA_MODEL_REVISION || '',
    allowedRoot = process.env.ECAPA_ALLOWED_WAV_ROOT || null,
    threads = clampInt(process.env.ECAPA_THREADS, 2, 1, 8),
    requestTimeoutMs = clampInt(
      process.env.ECAPA_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      10,
      300_000,
    ),
    startupTimeoutMs = clampInt(
      process.env.ECAPA_STARTUP_TIMEOUT_MS,
      DEFAULT_STARTUP_TIMEOUT_MS,
      100,
      300_000,
    ),
    maxQueue = clampInt(process.env.ECAPA_MAX_QUEUE, 4, 1, 32),
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    maxWavBytes = DEFAULT_MAX_WAV_BYTES,
    spawnImpl = spawn,
    fsPromises = fsp,
  } = {}) {
    this.pythonBin = pythonBin;
    this.scriptPath = path.resolve(scriptPath);
    this.modelDir = path.resolve(modelDir);
    this.modelRevision = String(modelRevision || '').slice(0, 120);
    if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
      throw new EcapaLidError(
        'CONFIG_ERROR',
        'ECAPA allowed WAV root must be configured explicitly',
      );
    }
    this.allowedRoot = path.resolve(allowedRoot);
    this.threads = clampInt(threads, 2, 1, 8);
    this.requestTimeoutMs = clampInt(
      requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      10,
      300_000,
    );
    this.startupTimeoutMs = clampInt(
      startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      100,
      300_000,
    );
    this.maxQueue = clampInt(maxQueue, 4, 1, 32);
    this.maxOutputChars = clampInt(
      maxOutputChars,
      DEFAULT_MAX_OUTPUT_CHARS,
      1024,
      1024 * 1024,
    );
    this.maxWavBytes = clampInt(
      maxWavBytes,
      DEFAULT_MAX_WAV_BYTES,
      4096,
      512 * 1024 * 1024,
    );
    this.spawnImpl = spawnImpl;
    this.fsPromises = fsPromises;

    this.child = null;
    this.ready = false;
    this.readyInfo = null;
    this.startupPromise = null;
    this.startupResolve = null;
    this.startupReject = null;
    this.startupTimer = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.queue = [];
    this.active = null;
    this.draining = false;
    this.closed = false;
    this.spawnCount = 0;
    this.lastError = null;
  }

  health() {
    return {
      configured: Boolean(this.pythonBin && this.modelDir),
      ready: this.ready,
      busy: Boolean(this.active),
      queueDepth: this.queue.length,
      pid: this.child && Number.isInteger(this.child.pid) ? this.child.pid : null,
      spawnCount: this.spawnCount,
      restartCount: Math.max(0, this.spawnCount - 1),
      protocol: PROTOCOL_VERSION,
      engine: this.readyInfo && this.readyInfo.engine ? this.readyInfo.engine : null,
      startup: this.readyInfo && this.readyInfo.startup ? this.readyInfo.startup : null,
      lastError: this.lastError,
    };
  }

  async classify(wavPath) {
    if (this.closed) {
      throw new EcapaLidError('CLOSED', 'ECAPA worker bridge is closed');
    }
    const startedAt = performance.now();
    const wav = await validateWavPath(wavPath, {
      allowedRoot: this.allowedRoot,
      maxWavBytes: this.maxWavBytes,
      fsPromises: this.fsPromises,
    });
    if (this.closed) {
      throw new EcapaLidError('CLOSED', 'ECAPA worker bridge is closed');
    }
    if (this.queue.length >= this.maxQueue) {
      throw new EcapaLidError('QUEUE_FULL', 'ECAPA benchmark queue is full', true);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: crypto.randomUUID(),
        wavPath: wav.path,
        wavBytes: wav.bytes,
        startedAt,
        enqueuedAt: performance.now(),
        sentAt: 0,
        timer: null,
        resolve,
        reject,
      });
      this._scheduleDrain();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new EcapaLidError('CLOSED', 'ECAPA worker bridge is closed');
    this._rejectStartup(error);
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = null;
    }
    for (const item of this.queue.splice(0)) item.reject(error);
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.readyInfo = null;
    if (child) {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  }

  _scheduleDrain() {
    queueMicrotask(() => this._drain().catch(() => {}));
  }

  async _drain() {
    if (this.closed || this.draining || this.active || !this.queue.length) return;
    this.draining = true;
    const item = this.queue.shift();
    try {
      await this._ensureStarted();
      if (this.closed) throw new EcapaLidError('CLOSED', 'ECAPA worker bridge is closed');
      if (!this.child || !this.ready || !this.child.stdin) {
        throw new EcapaLidError('WORKER_EXITED', 'ECAPA worker is unavailable', true);
      }
      this.active = item;
      item.sentAt = performance.now();
      item.timer = setTimeout(() => {
        if (this.active !== item) return;
        this._failChild(
          this.child,
          new EcapaLidError('TIMEOUT', 'ECAPA inference timed out', true),
          true,
        );
      }, this.requestTimeoutMs);
      const line = `${JSON.stringify({
        type: 'classify',
        protocol: PROTOCOL_VERSION,
        id: item.id,
        wavPath: item.wavPath,
      })}\n`;
      this.child.stdin.write(line, (error) => {
        if (error && this.active === item) {
          this._failChild(
            this.child,
            new EcapaLidError('WORKER_EXITED', 'Unable to write to ECAPA worker', true),
            true,
          );
        }
      });
    } catch (error) {
      item.reject(error instanceof EcapaLidError
        ? error
        : new EcapaLidError('WORKER_FAILED', cleanText(error && error.message), true));
      this._scheduleDrain();
    } finally {
      this.draining = false;
    }
  }

  _ensureStarted() {
    if (this.ready && this.child) return Promise.resolve(this.readyInfo);
    if (this.startupPromise) return this.startupPromise;
    if (this.closed) {
      return Promise.reject(new EcapaLidError('CLOSED', 'ECAPA worker bridge is closed'));
    }

    let resolveStartup;
    let rejectStartup;
    const promise = new Promise((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    this.startupPromise = promise;
    this.startupResolve = resolveStartup;
    this.startupReject = rejectStartup;

    let child;
    try {
      child = this.spawnImpl(this.pythonBin, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ECAPA_MODEL_DIR: this.modelDir,
          ECAPA_MODEL_REVISION: this.modelRevision,
          ECAPA_ALLOWED_WAV_ROOT: this.allowedRoot,
          ECAPA_MAX_WAV_BYTES: String(this.maxWavBytes),
          ECAPA_THREADS: String(this.threads),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
      });
    } catch (_) {
      const error = new EcapaLidError('SPAWN_FAILED', 'Unable to start ECAPA worker', true);
      this._rejectStartup(error);
      return promise;
    }

    this.child = child;
    this.ready = false;
    this.readyInfo = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.spawnCount += 1;

    child.stdout?.on('data', (chunk) => this._onStdout(child, chunk));
    child.stderr?.on('data', (chunk) => {
      if (this.child !== child) return;
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-this.maxOutputChars);
    });
    child.on('error', () => {
      this._failChild(
        child,
        new EcapaLidError('WORKER_EXITED', 'ECAPA worker process failed', true),
        false,
      );
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      const suffix = signal ? ` (${cleanText(signal, 'signal')})` : '';
      this._failChild(
        child,
        new EcapaLidError(
          'WORKER_EXITED',
          `ECAPA worker exited${Number.isInteger(code) ? ` with code ${code}` : ''}${suffix}`,
          true,
        ),
        false,
      );
    });
    this.startupTimer = setTimeout(() => {
      this._failChild(
        child,
        new EcapaLidError('STARTUP_TIMEOUT', 'ECAPA worker startup timed out', true),
        true,
      );
    }, this.startupTimeoutMs);
    return promise;
  }

  _onStdout(child, chunk) {
    if (this.child !== child) return;
    const text = chunk.toString();
    if (text.length > this.maxOutputChars) {
      this._failChild(
        child,
        new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker output exceeded its bound'),
        true,
      );
      return;
    }
    this.stdoutBuffer += text;
    if (this.stdoutBuffer.length > this.maxOutputChars && !this.stdoutBuffer.includes('\n')) {
      this._failChild(
        child,
        new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker output line exceeded its bound'),
        true,
      );
      return;
    }

    while (this.stdoutBuffer.includes('\n')) {
      const newline = this.stdoutBuffer.indexOf('\n');
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > this.maxOutputChars) {
        this._failChild(
          child,
          new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker output line exceeded its bound'),
          true,
        );
        return;
      }
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        this._failChild(
          child,
          new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker emitted invalid JSON'),
          true,
        );
        return;
      }
      if (!this._handleMessage(child, message)) return;
    }
  }

  _handleMessage(child, message) {
    if (!message || typeof message !== 'object') {
      this._failChild(
        child,
        new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker emitted an invalid message'),
        true,
      );
      return false;
    }
    if (message.type === 'ready') {
      const readyRevision = String(message.engine && message.engine.revision || '');
      if (
        this.ready ||
        message.protocol !== PROTOCOL_VERSION ||
        !message.engine ||
        typeof message.engine !== 'object' ||
        message.engine.family !== 'speechbrain-ecapa' ||
        message.engine.model !== 'lang-id-voxlingua107-ecapa' ||
        Number(message.engine.classes) !== 107 ||
        (this.modelRevision && readyRevision !== this.modelRevision)
      ) {
        this._failChild(
          child,
          new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker readiness message is invalid'),
          true,
        );
        return false;
      }
      const startupMs = finiteNumber(message.startup && message.startup.startupMs, 0, 300_000);
      const warmupMs = finiteNumber(message.startup && message.startup.warmupMs, 0, 300_000);
      if (startupMs === null || warmupMs === null) {
        this._failChild(
          child,
          new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker startup metrics are invalid'),
          true,
        );
        return false;
      }
      this.ready = true;
      this.readyInfo = {
        engine: {
          family: cleanText(message.engine.family, 'speechbrain-ecapa'),
          model: cleanText(message.engine.model, 'lang-id-voxlingua107-ecapa'),
          revision: cleanText(message.engine.revision, 'unknown'),
          speechbrain: cleanText(message.engine.speechbrain, 'unknown'),
          torch: cleanText(message.engine.torch, 'unknown'),
          classes: clampInt(message.engine.classes, 107, 1, 1000),
          threads: clampInt(message.engine.threads, this.threads, 1, 64),
        },
        startup: { startupMs, warmupMs },
      };
      this._resolveStartup(this.readyInfo);
      return true;
    }
    if (message.type === 'fatal') {
      this._failChild(
        child,
        new EcapaLidError(
          'STARTUP_FAILED',
          cleanText(message.error && message.error.message, 'ECAPA worker startup failed'),
          false,
        ),
        true,
      );
      return false;
    }
    if (message.type !== 'result' || !this.active || message.id !== this.active.id) {
      this._failChild(
        child,
        new EcapaLidError('PROTOCOL_ERROR', 'ECAPA worker response did not match the request'),
        true,
      );
      return false;
    }

    const item = this.active;
    this.active = null;
    clearTimeout(item.timer);
    try {
      item.resolve(normalizeWorkerResult(message, item));
    } catch (error) {
      item.reject(error);
      if (error && error.code === 'PROTOCOL_ERROR') {
        this._failChild(child, error, true);
        return false;
      }
    }
    this._scheduleDrain();
    return true;
  }

  _resolveStartup(value) {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const resolve = this.startupResolve;
    this.startupPromise = null;
    this.startupResolve = null;
    this.startupReject = null;
    if (resolve) resolve(value);
  }

  _rejectStartup(error) {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const reject = this.startupReject;
    this.startupPromise = null;
    this.startupResolve = null;
    this.startupReject = null;
    if (reject) reject(error);
  }

  _failChild(child, error, kill) {
    if (child && this.child !== child) return;
    this.lastError = {
      code: error.code || 'WORKER_FAILED',
      message: cleanText(error.message),
      at: new Date().toISOString(),
    };
    this._rejectStartup(error);
    if (this.active) {
      const item = this.active;
      this.active = null;
      clearTimeout(item.timer);
      item.reject(error);
    }
    const target = this.child;
    this.child = null;
    this.ready = false;
    this.readyInfo = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    if (kill && target) {
      try { target.kill('SIGKILL'); } catch (_) {}
    }
    this._scheduleDrain();
  }
}

module.exports = {
  EcapaLidError,
  EcapaLidWorker,
  canonicalLanguage,
  isWithinRoot,
  validateWavPath,
};
