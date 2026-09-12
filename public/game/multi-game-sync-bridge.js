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

  // ===== 滚动隔离：同步必须静默发生，不得改变宿主页面（多开网格）的滚动位置 =====
  // 游戏内的 DOM 输入框（EditBox）进入编辑态时，cocos 运行时会：
  //   1) 调用 input.focus()；
  //   2) 800ms 后调用 input.scrollIntoView({ block: "start", behavior: "smooth" })。
  // 这两处滚动副作用会沿包含链跨越 iframe 边界向上冒泡，把宿主页面的网格容器
  // 滚到当前窗口所在的位置 —— 表现就是"点了主窗口，页面却移到后面那一行的窗口"。
  // 从窗口是被同步驱动的，这类滚动毫无意义，因此统一限制在当前 iframe 文档内部。
  let scrollIsolationPatched = false;
  let nativeScrollIntoView = null;
  let nativeFocus = null;

  /**
   * scrollIntoView 的等价实现：只滚动当前 iframe 文档内的滚动容器
   * 与原生实现的关键差异是——parentElement 链在本文档的 documentElement 终止，
   * 绝不会再上溯到宿主文档，因此宿主滚动位置永远不受影响。
   */
  function scrollIntoViewWithinDocument(element, options) {
    const config = options && typeof options === "object" ? options : {};
    const block = config.block;
    const inline = config.inline;
    let node = element.parentElement;
    while (node) {
      const scrollableY = node.scrollHeight > node.clientHeight + 1;
      const scrollableX = node.scrollWidth > node.clientWidth + 1;
      if (scrollableY || scrollableX) {
        const containerRect = node.getBoundingClientRect();
        const rect = element.getBoundingClientRect();

        if (scrollableY) {
          const visible =
            rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
          // 未指定 block（或 nearest）时只在不可见时滚，其余对齐值一律生效
          const shouldScroll =
            !visible || block === "start" || block === "center" || block === "end";
          if (shouldScroll) {
            const offset = rect.top - containerRect.top + node.scrollTop;
            const target =
              block === "center"
                ? offset - node.clientHeight / 2 + rect.height / 2
                : block === "end"
                  ? offset - node.clientHeight + rect.height
                  : offset;
            node.scrollTop = Math.max(0, target);
          }
        }

        if (scrollableX) {
          const visible =
            rect.left >= containerRect.left && rect.right <= containerRect.right;
          const shouldScroll =
            !visible || inline === "start" || inline === "center" || inline === "end";
          if (shouldScroll) {
            const offset = rect.left - containerRect.left + node.scrollLeft;
            const target =
              inline === "center"
                ? offset - node.clientWidth / 2 + rect.width / 2
                : inline === "end"
                  ? offset - node.clientWidth + rect.width
                  : offset;
            node.scrollLeft = Math.max(0, target);
          }
        }
      }
      node = node.parentElement;
    }

    // 本文档视口自身的滚动，同样只作用于当前窗口
    const doc = root.document;
    const viewportHeight = root.innerHeight || doc?.documentElement?.clientHeight || 0;
    if (viewportHeight > 0) {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > viewportHeight) {
        root.scrollTo(root.scrollX, Math.max(0, root.scrollY + rect.top));
      }
    }
  }

  function enableScrollIsolation() {
    if (scrollIsolationPatched) return;
    const elementProto = root.Element && root.Element.prototype;
    const htmlElementProto = root.HTMLElement && root.HTMLElement.prototype;
    if (!elementProto && !htmlElementProto) return;

    if (elementProto && typeof elementProto.scrollIntoView === "function") {
      nativeScrollIntoView = elementProto.scrollIntoView;
      elementProto.scrollIntoView = function scrollIntoView(options) {
        try {
          scrollIntoViewWithinDocument(this, options);
        } catch {
          // 隔离失败时宁可不动，也绝不把宿主页面滚走
        }
      };
    }

    if (htmlElementProto && typeof htmlElementProto.focus === "function") {
      nativeFocus = htmlElementProto.focus;
      htmlElementProto.focus = function focus(options) {
        const nextOptions =
          options && typeof options === "object"
            ? { ...options, preventScroll: true }
            : { preventScroll: true };
        try {
          return nativeFocus.call(this, nextOptions);
        } catch {
          return nativeFocus.call(this);
        }
      };
    }

    scrollIsolationPatched = true;
  }

  function disableScrollIsolation() {
    if (!scrollIsolationPatched) return;
    const elementProto = root.Element && root.Element.prototype;
    const htmlElementProto = root.HTMLElement && root.HTMLElement.prototype;
    if (elementProto && nativeScrollIntoView) {
      elementProto.scrollIntoView = nativeScrollIntoView;
    }
    if (htmlElementProto && nativeFocus) {
      htmlElementProto.focus = nativeFocus;
    }
    nativeScrollIntoView = null;
    nativeFocus = null;
    scrollIsolationPatched = false;
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

      // 同步开启期间隔离滚动副作用，避免从窗口把宿主网格滚到别处
      if (syncEnabled) enableScrollIsolation();
      else disableScrollIsolation();

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
      enableScrollIsolation();
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
        enableScrollIsolation();
        attachLocalListeners();
      },
      disable: () => {
        syncEnabled = false;
        disableScrollIsolation();
        detachLocalListeners();
      },
      setThrottle: (ms) => {
        throttleMs = typeof ms === "number" ? ms : 16;
      },
      isScrollIsolated: () => scrollIsolationPatched,
    },
  };
})(window);
