import { extractStartLevel } from "./endLevel.js";

export const PUSH_LEVEL_STATES = Object.freeze([
  "idle",
  "waiting",
  "starting",
  "building-result",
  "submitting",
  "confirming",
  "ready",
  "paused",
  "stopped",
  "error",
]);

const DEFAULT_SETTINGS = Object.freeze({
  baseIntervalMs: 30000,
  jitterMs: 5000,
  minIntervalMs: 5000,
  maxIntervalMs: 120000,
  maxStartRetries: 0,
  autoContinue: true,
});

const finiteOr = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const normalizeSchedulerSettings = (settings = {}) => {
  const minIntervalMs = Math.max(
    0,
    finiteOr(settings.minIntervalMs, DEFAULT_SETTINGS.minIntervalMs),
  );
  const maxIntervalMs = Math.max(
    minIntervalMs,
    finiteOr(settings.maxIntervalMs, DEFAULT_SETTINGS.maxIntervalMs),
  );

  return {
    baseIntervalMs: Math.max(
      0,
      finiteOr(settings.baseIntervalMs, DEFAULT_SETTINGS.baseIntervalMs),
    ),
    jitterMs: Math.max(
      0,
      finiteOr(settings.jitterMs, DEFAULT_SETTINGS.jitterMs),
    ),
    minIntervalMs,
    maxIntervalMs,
    maxStartRetries: Math.max(
      0,
      Math.floor(
        finiteOr(
          settings.maxStartRetries ?? settings.maxRetries,
          DEFAULT_SETTINGS.maxStartRetries,
        ),
      ),
    ),
    autoContinue: settings.autoContinue !== false,
  };
};

export const secureRandomUnit = () => {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    const values = new Uint32Array(1);
    cryptoObject.getRandomValues(values);
    return values[0] / 0x100000000;
  }

  return Math.random();
};

export const calculateJitteredDelay = (
  settings,
  randomUnit = secureRandomUnit,
) => {
  const normalized = normalizeSchedulerSettings(settings);
  const unit = Math.min(1, Math.max(0, Number(randomUnit())));
  const offset = (unit * 2 - 1) * normalized.jitterMs;
  return Math.round(
    Math.min(
      normalized.maxIntervalMs,
      Math.max(normalized.minIntervalMs, normalized.baseIntervalMs + offset),
    ),
  );
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error || "未知错误");

const stoppedOrPaused = (scheduler) =>
  scheduler.paused ? { paused: true } : { stopped: true };

export class PushLevelScheduler {
  constructor({
    tokenId = "",
    startLevel,
    buildResult,
    submit,
    confirm,
    settings,
    randomUnit = secureRandomUnit,
    onEvent = () => {},
  } = {}) {
    if (typeof startLevel !== "function") {
      throw new TypeError("startLevel must be a function");
    }
    if (typeof buildResult !== "function") {
      throw new TypeError("buildResult must be a function");
    }
    if (submit !== undefined && typeof submit !== "function") {
      throw new TypeError("submit must be a function");
    }
    if (submit && typeof confirm !== "function") {
      throw new TypeError("confirm is required when submit is provided");
    }

    this.tokenId = tokenId;
    this.startLevel = startLevel;
    this.buildResult = buildResult;
    this.submit = submit;
    this.confirm = confirm;
    this.settings = normalizeSchedulerSettings(settings);
    this.randomUnit = randomUnit;
    this.onEvent = onEvent;
    this.state = "idle";
    this.running = false;
    this.stopRequested = false;
    this.paused = false;
    this.cycleCount = 0;
    this.lastDelayMs = 0;
    this.lastResult = null;
    this.runPromise = null;
    this.waiters = new Set();
    this.inFlightOperation = "";
    this.inFlightSubmit = false;
    this.resumePromise = null;
    this.runGeneration = 0;
  }

  emit(type, payload = {}) {
    try {
      this.onEvent({
        type,
        tokenId: this.tokenId,
        state: this.state,
        cycle: this.cycleCount,
        at: new Date().toISOString(),
        ...payload,
      });
    } catch {}
  }

  setState(state, payload = {}) {
    if (!PUSH_LEVEL_STATES.includes(state)) {
      throw new TypeError(`Unknown push level state: ${state}`);
    }
    this.state = state;
    this.emit("state", payload);
  }

  wait(delayMs) {
    if (this.stopRequested || this.paused) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(true), delayMs);
      const cancel = () => finish(false);
      const finish = (completed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(cancel);
        resolve(completed && !this.stopRequested && !this.paused);
      };
      this.waiters.add(cancel);
    });
  }

  cancelWaiters() {
    Array.from(this.waiters).forEach((cancel) => cancel());
  }

  stop() {
    this.stopRequested = true;
    this.paused = false;
    this.cancelWaiters();
    this.setState("stopped");
  }

  pause() {
    if (!this.running) return;
    this.paused = true;
    this.cancelWaiters();
    this.setState("paused");
  }

  resume() {
    if (this.state !== "paused") return this.runPromise;
    this.stopRequested = false;
    if (!this.runPromise) {
      this.paused = false;
      return this.start({ immediate: true });
    }
    if (this.resumePromise) return this.resumePromise;

    const previousRun = this.runPromise;
    this.resumePromise = (async () => {
      await previousRun.catch(() => this.lastResult);
      if (this.stopRequested || this.state !== "paused") return this.lastResult;

      this.paused = false;
      return this.start({ immediate: true });
    })()
      .finally(() => {
        this.resumePromise = null;
      });
    return this.resumePromise;
  }

  waitForIdle() {
    const pending = this.resumePromise || this.runPromise;
    return pending
      ? pending.catch(() => this.lastResult)
      : Promise.resolve(this.lastResult);
  }

  async runOnce({ wait = true } = {}) {
    if (this.stopRequested || this.state === "stopped") {
      return { stopped: true };
    }
    if (this.paused) {
      return { paused: true };
    }

    this.cycleCount += 1;
    if (wait) {
      this.lastDelayMs = calculateJitteredDelay(this.settings, this.randomUnit);
      this.setState("waiting", { delayMs: this.lastDelayMs });
      const completed = await this.wait(this.lastDelayMs);
      if (!completed) return this.paused ? { paused: true } : { stopped: true };
    }

    try {
      this.setState("starting");
      this.inFlightOperation = "startLevel";
      const startResponse = await this.startWithRetry();
      this.inFlightOperation = "";
      if (this.stopRequested || this.paused) {
        this.setState(this.paused ? "paused" : "stopped");
        return stoppedOrPaused(this);
      }
      const start = extractStartLevel(startResponse);
      const context = {
        tokenId: this.tokenId,
        cycle: this.cycleCount,
        ...start,
      };

      this.setState("building-result", { levelId: start.levelId, seed: start.seed });
      this.inFlightOperation = "buildResult";
      const preview = await this.buildResult(startResponse, context);
      this.inFlightOperation = "";
      if (this.stopRequested || this.paused) {
        this.setState(this.paused ? "paused" : "stopped");
        return stoppedOrPaused(this);
      }
      if (!preview || typeof preview !== "object" || !preview.payload) {
        throw new TypeError("buildResult must return a payload preview");
      }
      this.emit("preview", {
        levelId: start.levelId,
        seed: start.seed,
        outputCode: preview.outputCode || preview.payload.outputCode || "",
      });

      if (!this.submit) {
        this.lastResult = {
          ...context,
          preview,
          dryRun: true,
          submitted: false,
        };
        this.setState("ready", { mode: "dry-run", levelId: start.levelId });
        return this.lastResult;
      }

      this.setState("submitting", { levelId: start.levelId });
      this.inFlightOperation = "submit";
      this.inFlightSubmit = true;
      const response = await this.submit(preview.payload, context);
      this.inFlightSubmit = false;
      this.inFlightOperation = "";
      if (this.stopRequested || this.paused) {
        this.setState(this.paused ? "paused" : "stopped");
        return stoppedOrPaused(this);
      }
      this.setState("confirming", { levelId: start.levelId });
      this.inFlightOperation = "confirm";
      const confirmation = await this.confirm(response, preview, context);
      this.inFlightOperation = "";
      if (confirmation !== true && confirmation?.confirmed !== true) {
        throw new Error("服务器未确认主线关卡推进");
      }

      this.lastResult = {
        ...context,
        preview,
        response,
        confirmation,
        dryRun: false,
        submitted: true,
      };
      this.setState("ready", { mode: "submitted", levelId: start.levelId });
      this.emit("submitted", { levelId: start.levelId });
      return this.lastResult;
    } catch (error) {
      this.inFlightSubmit = false;
      this.inFlightOperation = "";
      if (this.stopRequested) {
        this.setState("stopped");
        return { stopped: true, error };
      }
      this.setState("error", { error: errorMessage(error) });
      this.emit("error", { error: errorMessage(error) });
      throw error;
    }
  }

  async startWithRetry() {
    let attempt = 0;
    while (true) {
      try {
        return await this.startLevel(this.tokenId);
      } catch (error) {
        if (attempt >= this.settings.maxStartRetries || this.stopRequested) {
          throw error;
        }
        attempt += 1;
        this.emit("retry", {
          operation: "startLevel",
          attempt,
          error: errorMessage(error),
        });
      }
    }
  }

  start({ immediate = false } = {}) {
    if (this.runPromise) return this.runPromise;
    this.stopRequested = false;
    this.paused = false;
    this.running = true;
    const generation = ++this.runGeneration;
    const runPromise = (async () => {
      let first = true;
      try {
        while (!this.stopRequested && !this.paused) {
          const result = await this.runOnce({ wait: !(immediate && first) });
          first = false;
          if (result.stopped || result.paused || !this.submit || !this.settings.autoContinue) {
            break;
          }
        }
        return this.lastResult;
      } finally {
        if (this.runGeneration === generation) {
          this.running = false;
          this.runPromise = null;
          if (this.stopRequested && this.state !== "stopped") this.setState("stopped");
        }
      }
    })();
    this.runPromise = runPromise;
    return runPromise;
  }
}

export default PushLevelScheduler;