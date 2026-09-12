(function installMultiGameSyncBridge(root) {
  "use strict";

  const EVENT_CHANNEL = "multi-game";
  const SYNC_CMD_CHANNEL = "multi-game-sync";
  const VERSION = 1;
  const scope = root.__MULTI_GAME_BRIDGE_READY__?.scope || "";

  // 需要捕获并转发的事件类型
  const MOUSE_EVENTS = [
    "mousedown",
    "mousemove",
    "mouseup",
    "mouseenter",
    "mouseleave",
    "wheel",
    "contextmenu",
  ];

  const TOUCH_EVENTS = ["touchstart", "touchmove", "touchend", "touchcancel"];

  const ALL_EVENTS = [...MOUSE_EVENTS, ...TOUCH_EVENTS];

  // 同步状态
  let syncEnabled = false;
  let lastSentAt = 0;
  let throttleMs = 16; // ~60fps 节流
  let ignoreNextRemoteEvents = false;

  function getCanvas() {
    return root.document?.getElementById?.("GameCanvas") || null;
  }

  /**
   * 将事件坐标转换为归一化坐标 (0-1)
   * 这样不同尺寸的 iframe 都能正确映射
   */
  function normalizePoint(clientX, clientY) {
    const canvas = getCanvas();
    if (!canvas) return { x: 0.5, y: 0.5 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5,
      y: rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5,
    };
  }

  /**
   * 从归一化坐标转换回实际客户端坐标
   */
  function denormalizePoint(nx, ny) {
    const canvas = getCanvas();
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + nx * rect.width,
      y: rect.top + ny * rect.height,
    };
  }

  /**
   * 从原生事件中提取可序列化的数据
   */
  function extractEventData(event) {
    const data = {
      type: event.type,
      timeStamp: event.timeStamp,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      button: event.button ?? 0,
      buttons: event.buttons ?? 0,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };

    if (event.type === "wheel") {
      data.deltaX = event.deltaX;
      data.deltaY = event.deltaY;
      data.deltaZ = event.deltaZ;
      data.deltaMode = event.deltaMode;
      data.pointerType = "mouse";
      const p = normalizePoint(event.clientX, event.clientY);
      data.nx = p.x;
      data.ny = p.y;
      return data;
    }

    if (event.type.startsWith("touch")) {
      data.pointerType = "touch";
      data.changedTouches = Array.from(event.changedTouches || []).map((t) => {
        const p = normalizePoint(t.clientX, t.clientY);
        return {
          identifier: t.identifier,
          nx: p.x,
          ny: p.y,
          radiusX: t.radiusX,
          radiusY: t.radiusY,
          rotationAngle: t.rotationAngle,
          force: t.force,
        };
      });
      data.touches = Array.from(event.touches || []).map((t) => {
        const p = normalizePoint(t.clientX, t.clientY);
        return {
          identifier: t.identifier,
          nx: p.x,
          ny: p.y,
          radiusX: t.radiusX,
          radiusY: t.radiusY,
          rotationAngle: t.rotationAngle,
          force: t.force,
        };
      });
      data.targetTouches = Array.from(event.targetTouches || []).map((t) => {
        const p = normalizePoint(t.clientX, t.clientY);
        return {
          identifier: t.identifier,
          nx: p.x,
          ny: p.y,
          radiusX: t.radiusX,
          radiusY: t.radiusY,
          rotationAngle: t.rotationAngle,
          force: t.force,
        };
      });
      return data;
    }

    // 鼠标 / pointer 事件
    data.pointerType = "mouse";
    const p = normalizePoint(event.clientX, event.clientY);
    data.nx = p.x;
    data.ny = p.y;
    return data;
  }

  /**
   * 将序列化的事件数据还原为原生 DOM 事件并派发
   */
  function dispatchRemoteEvent(data) {
    const canvas = getCanvas();
    if (!canvas) return;

    const ignore = ignoreNextRemoteEvents;
    // 防止事件循环：派发的事件又被监听到
    ignoreNextRemoteEvents = true;

    try {
      if (data.type === "wheel") {
        const { x, y } = denormalizePoint(data.nx, data.ny);
        const event = new WheelEvent(data.type, {
          bubbles: data.bubbles,
          cancelable: data.cancelable,
          clientX: x,
          clientY: y,
          button: data.button,
          buttons: data.buttons,
          shiftKey: data.shiftKey,
          ctrlKey: data.ctrlKey,
          altKey: data.altKey,
          metaKey: data.metaKey,
          deltaX: data.deltaX,
          deltaY: data.deltaY,
          deltaZ: data.deltaZ,
          deltaMode: data.deltaMode,
        });
        canvas.dispatchEvent(event);
        return;
      }

      if (data.type.startsWith("touch")) {
        // 构造 Touch 对象
        const createTouch = (t) => {
          const { x, y } = denormalizePoint(t.nx, t.ny);
          return new Touch({
            identifier: t.identifier,
            target: canvas,
            clientX: x,
            clientY: y,
            radiusX: t.radiusX,
            radiusY: t.radiusY,
            rotationAngle: t.rotationAngle,
            force: t.force,
          });
        };

        const changedTouchesList = data.changedTouches?.map(createTouch) || [];
        const touchesList = data.touches?.map(createTouch) || [];
        const targetTouchesList = data.targetTouches?.map(createTouch) || [];

        const event = new TouchEvent(data.type, {
          bubbles: data.bubbles,
          cancelable: data.cancelable,
          changedTouches: changedTouchesList,
          touches: touchesList,
          targetTouches: targetTouchesList,
          shiftKey: data.shiftKey,
          ctrlKey: data.ctrlKey,
          altKey: data.altKey,
          metaKey: data.metaKey,
        });
        canvas.dispatchEvent(event);
        return;
      }

      // 鼠标事件
      const { x, y } = denormalizePoint(data.nx, data.ny);
      const event = new MouseEvent(data.type, {
        bubbles: data.bubbles,
        cancelable: data.cancelable,
        clientX: x,
        clientY: y,
        button: data.button,
        buttons: data.buttons,
        shiftKey: data.shiftKey,
        ctrlKey: data.ctrlKey,
        altKey: data.altKey,
        metaKey: data.metaKey,
      });
      canvas.dispatchEvent(event);
    } finally {
      // 恢复忽略标记
      if (ignore) ignoreNextRemoteEvents = true;
      else ignoreNextRemoteEvents = false;
    }
  }

  /**
   * 本地事件处理：提取数据并发送到父页面
   */
  function handleLocalEvent(event) {
    if (!syncEnabled) return;
    if (ignoreNextRemoteEvents) return;

    // 节流
    const now = performance.now();
    if (now - lastSentAt < throttleMs) return;
    lastSentAt = now;

    // 只处理 canvas 上的事件
    const canvas = getCanvas();
    if (!canvas) return;
    if (event.target !== canvas && !canvas.contains?.(event.target)) return;

    const data = extractEventData(event);
    if (!root.parent || root.parent === root) return;

    root.parent.postMessage(
      {
        channel: EVENT_CHANNEL,
        version: VERSION,
        type: "user-event",
        scope,
        event: data,
      },
      root.location.origin,
    );
  }

  function attachLocalListeners() {
    const canvas = getCanvas();
    if (!canvas) return;
    ALL_EVENTS.forEach((type) => {
      canvas.addEventListener(type, handleLocalEvent, true);
    });
  }

  function detachLocalListeners() {
    const canvas = getCanvas();
    if (!canvas) return;
    ALL_EVENTS.forEach((type) => {
      canvas.removeEventListener(type, handleLocalEvent, true);
    });
  }

  function handleParentMessage(event) {
    if (event.origin !== root.location.origin || event.source !== root.parent) {
      return;
    }

    const payload = event.data;

    // 接收同步控制命令
    if (
      payload?.channel === SYNC_CMD_CHANNEL &&
      payload.version === VERSION &&
      payload.type === "config"
    ) {
      const prevEnabled = syncEnabled;
      syncEnabled = !!payload.enabled;
      throttleMs = typeof payload.throttleMs === "number" ? payload.throttleMs : 16;

      if (syncEnabled && !prevEnabled) {
        // 重新挂载监听器（以防 canvas 被重建）
        detachLocalListeners();
        attachLocalListeners();
      }
      return;
    }

    // 接收远程事件派发请求
    if (
      payload?.channel === SYNC_CMD_CHANNEL &&
      payload.version === VERSION &&
      payload.type === "forward-event" &&
      payload.scope !== scope && // 不是自己发回来的
      syncEnabled
    ) {
      ignoreNextRemoteEvents = true;
      dispatchRemoteEvent(payload.event);
      // 下一帧恢复
      root.requestAnimationFrame(() => {
        ignoreNextRemoteEvents = false;
      });
      return;
    }
  }

  // 等待 canvas 出现
  function waitForCanvas() {
    const tryNow = () => {
      if (getCanvas()) {
        if (syncEnabled) attachLocalListeners();
        return true;
      }
      return false;
    };
    if (tryNow()) return;
    // 定时检查，每 200ms 一次
    const timer = root.setInterval(() => {
      if (tryNow()) root.clearInterval(timer);
    }, 200);
  }

  root.addEventListener("message", handleParentMessage);
  waitForCanvas();

  root.__MULTI_GAME_SYNC_BRIDGE__ = {
    version: VERSION,
    sync: {
      isEnabled: () => syncEnabled,
      enable: () => {
        syncEnabled = true;
        attachLocalListeners();
      },
      disable: () => {
        syncEnabled = false;
        detachLocalListeners();
      },
      setThrottle: (ms) => {
        throttleMs = typeof ms === "number" ? ms : 16;
      },
    },
  };
})(window);
