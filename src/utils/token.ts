import axios from "axios";
import { MD5, lib, enc } from "crypto-js";
import { g_utils } from "@/utils/bonProtocol";

export const getTokenId = (token: string | ArrayBuffer | Uint8Array) => {
  const binHash = MD5(lib.WordArray.create(token)).toString(enc.Hex);
  return binHash;
};

// 稳定身份键已抽到零依赖模块（node 测试环境 import token.ts 会因 crypto-js CJS 探测失败而崩）
export { getStableTokenKey } from "@/utils/stableTokenKey";

type WaitCallback = (waitTimeMs: number, queueSize: number) => void;

class RateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private requests: number[] = [];
  private queueSize: number = 0;
  private onWaitCallback: WaitCallback | null = null;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  onWait(callback: WaitCallback): void {
    this.onWaitCallback = callback;
  }

  private cleanOldRequests(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.requests = this.requests.filter((time) => time > cutoff);
  }

  private async waitForSlot(): Promise<void> {
    this.cleanOldRequests();

    if (this.requests.length < this.maxRequests) {
      this.requests.push(Date.now());
      return;
    }

    const oldestRequest = this.requests[0];
    const waitTime = oldestRequest + this.windowMs - Date.now();

    if (waitTime > 0) {
      // 每秒更新一次剩余时间
      const updateInterval = 1000;
      const totalWaitTime = waitTime + 100;
      const startTime = Date.now();

      const updateCallback = () => {
        if (this.onWaitCallback) {
          const elapsed = Date.now() - startTime;
          const remaining = Math.max(0, totalWaitTime - elapsed);
          this.onWaitCallback(remaining, this.queueSize);
        }
      };

      // 初始通知
      updateCallback();

      // 设置定时更新
      const intervalId = setInterval(updateCallback, updateInterval);

      try {
        await new Promise((resolve) => setTimeout(resolve, totalWaitTime));
      } finally {
        clearInterval(intervalId);
      }
    }

    return this.waitForSlot();
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    this.queueSize++;
    try {
      await this.waitForSlot();
      return fn();
    } finally {
      this.queueSize--;
    }
  }
}

const authUserRateLimiter = new RateLimiter(25, 60000);

export const setAuthUserRateLimiterCallback = (
  callback: WaitCallback,
): void => {
  authUserRateLimiter.onWait(callback);
};

export const scheduleAuthUserRequest = <T>(
  fn: () => Promise<T>,
): Promise<T> => {
  return authUserRateLimiter.schedule(fn);
};

export const validateEncryptedToken = (token: unknown): token is string => {
  if (typeof token !== "string") return false;

  const trimmedToken = token.trim();
  if (trimmedToken.length < 10) return false;

  try {
    const parsed = JSON.parse(trimmedToken);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.roleToken === "string" &&
      parsed.roleToken.trim().length >= 10
    );
  } catch {
    return false;
  }
};

export const transformToken = async (arrayBuffer: ArrayBuffer) => {
  return authUserRateLimiter.schedule(async () => {
    const res = await axios.post(
      "https://xxz-xyzw.hortorgames.com/login/authuser",
      arrayBuffer,
      {
        params: {
          _seq: 1,
        },
        headers: {
          "Content-Type": "application/octet-stream",
          referrerPolicy: "no-referrer",
        },
        responseType: "arraybuffer",
      },
    );
    const msg = g_utils.parse(res.data);
    const data = msg.getData();
    const currentTime = Date.now();
    const sessId = currentTime * 100 + Math.floor(Math.random() * 100);
    const connId = currentTime + Math.floor(Math.random() * 10);

    // 🔴 实验F（claim 会话缺口分析 docs/goldenfish-claim-session-gap-analysis.md §4）：
    // 游戏原生客户端 WS 连接参数固定四字段 {roleToken, sessId, connId, isRestore}
    // （游戏 SDK src/xyzw/index.js _connParam + master 2026-10-01 27c DevTools 实抓），
    // 从不发送 roleId；此前 `...data` 把 authuser 响应里的 roleId(=uid) 也塞进 p=，
    // 是批量页与游戏本体会话在握手 URL 上的唯一差异。manual.vue 手动导入格式本就是四字段。
    return JSON.stringify({
      roleToken: (data as { roleToken?: string }).roleToken,
      sessId,
      connId,
      isRestore: 0,
    });
  });
};

export const getServerList = async (arrayBuffer: ArrayBuffer) => {
  // 如果是data URL格式，提取base64部分
  const res = await axios.post(
    "https://xxz-xyzw.hortorgames.com/login/serverlist",
    arrayBuffer,
    {
      params: {
        _seq: 3,
      },
      headers: {
        "Content-Type": "application/octet-stream",
        referrerPolicy: "no-referrer",
      },
      responseType: "arraybuffer",
    },
  );
  // console.log("res:", res);

  const msg = g_utils.parse(res.data);
  // console.log("解析结果:", msg);

  const data = msg.getData();
  console.log("数据内容:", data);
  return JSON.stringify({
    ...data.roles,
  });
};
