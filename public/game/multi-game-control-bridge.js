(function installMultiGameControlBridge(root) {
  "use strict";

  const CONTROL_CHANNEL = "multi-game-control";
  const EVENT_CHANNEL = "multi-game";
  const VERSION = 1;
  const scope = root.__MULTI_GAME_BRIDGE_READY__?.scope || "";

  const getAutomation = () => root.__SALT_FIELD_AUTO__;
  const getStats = () => getAutomation()?.getStats?.() || null;

  const actions = {
    start() {
      getAutomation()?.start?.();
      return getStats();
    },
    stop() {
      getAutomation()?.stop?.();
      return getStats();
    },
    getStats() {
      return getStats();
    },
    async deploy() {
      await getAutomation()?.debug?.deployNow?.();
      return getStats();
    },
    async march() {
      await getAutomation()?.debug?.marchNow?.();
      return getStats();
    },
    async attack() {
      await getAutomation()?.debug?.attackNow?.();
      return getStats();
    },
    async speedUp() {
      await getAutomation()?.debug?.speedUpNow?.();
      return getStats();
    },
  };

  function respond(requestId, ok, result, error) {
    if (!root.parent || root.parent === root) return;
    root.parent.postMessage(
      {
        channel: EVENT_CHANNEL,
        version: VERSION,
        type: "control-result",
        scope,
        requestId,
        ok,
        ...(ok ? { result } : { error }),
      },
      root.location.origin,
    );
  }

  async function handleMessage(event) {
    if (event.origin !== root.location.origin || event.source !== root.parent) {
      return;
    }

    const payload = event.data;
    if (
      payload?.channel !== CONTROL_CHANNEL ||
      payload.version !== VERSION ||
      payload.type !== "command" ||
      typeof payload.requestId !== "string" ||
      typeof payload.action !== "string"
    ) {
      return;
    }

    const action = actions[payload.action];
    if (!action) {
      respond(payload.requestId, false, null, "unsupported-action");
      return;
    }

    if (!getAutomation()) {
      respond(payload.requestId, false, null, "automation-unavailable");
      return;
    }

    try {
      const result = await action(payload.args);
      respond(payload.requestId, true, result, null);
    } catch (error) {
      respond(
        payload.requestId,
        false,
        null,
        error?.message || "automation-command-failed",
      );
    }
  }

  root.addEventListener("message", handleMessage);
  root.__MULTI_GAME_CONTROL_BRIDGE__ = {
    version: VERSION,
    channel: CONTROL_CHANNEL,
    scope,
  };
})(window);
