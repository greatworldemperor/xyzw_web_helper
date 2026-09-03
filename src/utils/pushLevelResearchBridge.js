const REQUEST_TYPE = "xyzw:push-research:request";
const RESPONSE_TYPE = "xyzw:push-research:response";
const EVENT_TYPE = "xyzw:push-research:event";

export class PushLevelResearchBridge {
  constructor(onEvent = () => {}) {
    this.iframe = null;
    this.onEvent = onEvent;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.handleMessage = this.handleMessage.bind(this);
    window.addEventListener("message", this.handleMessage);
  }

  attach(iframe) {
    this.iframe = iframe;
  }

  isReady() {
    return Boolean(this.iframe?.contentWindow);
  }

  request(command, payload = {}, timeout = 15000, transfer = []) {
    if (!this.isReady()) {
      return Promise.reject(new Error("研究 iframe 尚未加载"));
    }

    const requestId = `push-research-${Date.now()}-${this.nextRequestId++}`;
    const targetWindow = this.iframe.contentWindow;

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`iframe 请求超时: ${command}`));
      }, timeout);

      this.pending.set(requestId, { resolve, reject, timer });
      targetWindow.postMessage(
        {
          type: REQUEST_TYPE,
          requestId,
          command,
          payload,
        },
        window.location.origin,
        transfer,
      );
    });
  }

  handleMessage(event) {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;

    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === RESPONSE_TYPE && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;

      window.clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || "iframe 请求失败"));
      }
      return;
    }

    if (message.type === EVENT_TYPE) {
      this.onEvent(message.event, message.payload || {});
    }
  }

  dispose() {
    window.removeEventListener("message", this.handleMessage);
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("研究 iframe 已关闭"));
    }
    this.pending.clear();
    this.iframe = null;
  }
}

export const PUSH_RESEARCH_MESSAGE_TYPES = {
  REQUEST_TYPE,
  RESPONSE_TYPE,
  EVENT_TYPE,
};