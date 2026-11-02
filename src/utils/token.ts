import axios from "axios";
import { MD5, lib, enc } from "crypto-js";
import { g_utils } from "@/utils/bonProtocol";

export const getTokenId = (token: string | ArrayBuffer | Uint8Array) => {
  const binHash = MD5(lib.WordArray.create(token)).toString(enc.Hex);
  return binHash;
};

// 稳定身份键已抽到零依赖模块（node 测试环境 import token.ts 会因 crypto-js CJS 探测失败而崩）
export { getStableTokenKey } from "@/utils/stableTokenKey";

// 🔴 本地 authuser 限流器已删除（master 2026-11-03 口径）：
// 「让服务器来限」——服务器限流按 IP 计，切 IP（手机断网重连/PC 热点）瞬解，
// 本地 25/60s 预节流阈值是拍的（比服务器松=白堵路，比服务器紧=白拖慢），
// 批量切号场景下队列积压导致等待滚雪球（2026-11-02 一键竞技场 9 并发事故）。
// 现在刷新失败（限流/瞬断）统一走 tokenStore 的限流等待：弹窗 + 按可调间隔
// 重试 + 用户点「已更换 IP，立即重试」全线程立即唤醒。

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
      // 🔴 无 timeout 的 axios 在服务端悬挂时会无限等待（建连链路全部静默卡死）
      timeout: 15000,
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
