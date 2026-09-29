/**
 * 分组信息导出 / 导入（PC → 手机）
 *
 * 设计要点：
 *   · 只导出「分组结构」，绝不导出任何 token 密钥（token / 二进制 / url 等都不碰）。
 *   · 成员一律用稳定身份键 `serverId:roleId`（`getStableTokenKey`）标识，
 *     这样 PC 上建好的分组在手机上能按身份重新匹配，不受内部 token id 不同影响。
 *   · 盐场队伍额外导出 `leaderKey`（队长稳定键），导入时反查手机本机 token id；
 *     `memberRoleIds` 是稳定 role id，原样保留，运行时再按俱乐部名册解析。
 *   · 项目里有三套分组数据，本模块统一导出：
 *       - tokenGroups      ：批量日常页用的分组（@/stores/tokenStore 的 tokenGroups）
 *       - mgGroups         ：token 管理页用的「独立分组」（localStorage multiGameTokenGroups）
 *       - saltFieldTeams   ：自动盐场的队伍（localStorage saltFieldAutoTeams）
 *   · 导入默认「合并」：按身份/名字匹配已存在的，已存在则更新、不存在则新增，
 *     并给出可读报告（新增/更新/跳过/未匹配队长）。
 */

import { useLocalStorage } from "@vueuse/core";
import { tokenGroups, gameTokens } from "@/stores/tokenStore";
import { getTeams, setTeams, makeTeamId } from "@/utils/saltFieldConfig";
import { getStableTokenKey } from "@/utils/token";

export const GROUP_EXPORT_SCHEMA = "xyzw-group-export";
export const GROUP_EXPORT_VERSION = "1.0";

// 与 TokenImport/index.vue 中 GROUP_STORAGE_KEY 保持一致
export const MG_GROUP_STORAGE_KEY = "multiGameTokenGroups";
const mgGroups = useLocalStorage(MG_GROUP_STORAGE_KEY, []);

function nowIso() {
  return new Date().toISOString();
}

function normalizeKey(key) {
  return typeof key === "string" ? key.trim() : "";
}

function normalizeName(name) {
  return typeof name === "string" ? name.trim() : "";
}

/** 构建 稳定键 → 可读身份 的索引，便于手机端校验缺了哪些号 */
function buildKeyIndex() {
  const index = {};
  for (const t of gameTokens.value || []) {
    const key = getStableTokenKey(t.serverId, t.roleId);
    if (!key) continue;
    index[key] = {
      serverId: String(t.serverId ?? ""),
      roleId: String(t.roleId ?? ""),
      name: t.name || t.remark || "",
      server: t.server || "",
    };
  }
  return index;
}

/**
 * 组装导出对象（纯分组，无密钥）。
 * @param {{
 *   includeTokenGroups?: boolean,
 *   includeMgGroups?: boolean,
 *   includeSaltFieldTeams?: boolean
 * }} [opts]
 */
export function buildGroupExport({
  includeTokenGroups = true,
  includeMgGroups = true,
  includeSaltFieldTeams = true,
} = {}) {
  const payload = {
    schema: GROUP_EXPORT_SCHEMA,
    version: GROUP_EXPORT_VERSION,
    exportedAt: nowIso(),
    tokenGroups: [],
    mgGroups: [],
    saltFieldTeams: [],
    keyIndex: {},
  };

  if (includeTokenGroups) {
    payload.tokenGroups = (tokenGroups.value || []).map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      tokenKeys: Array.isArray(g.tokenKeys) ? [...g.tokenKeys] : [],
      createdAt: g.createdAt || null,
      updatedAt: g.updatedAt || null,
    }));
  }

  if (includeMgGroups) {
    payload.mgGroups = (mgGroups.value || []).map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      tokenKeys: Array.isArray(g.tokenKeys) ? [...g.tokenKeys] : [],
    }));
  }

  if (includeSaltFieldTeams) {
    const tokenById = new Map(
      (gameTokens.value || []).map((t) => [t.id, t]),
    );
    payload.saltFieldTeams = (getTeams() || []).map((t) => {
      const leader = tokenById.get(t.leaderTokenId);
      const leaderKey = leader
        ? getStableTokenKey(leader.serverId, leader.roleId)
        : null;
      return {
        id: t.id,
        name: t.name,
        enabled: !!t.enabled,
        mode: t.mode || "immediate",
        mobile: !!t.mobile,
        memberRoleIds: Array.isArray(t.memberRoleIds)
          ? [...t.memberRoleIds]
          : [],
        legionId: t.legionId ?? null,
        leaderKey,
      };
    });
  }

  payload.keyIndex = buildKeyIndex();
  return payload;
}

/** 序列化为可读性好的 JSON 文本 */
export function serializeGroupExport(payload) {
  return JSON.stringify(payload, null, 2);
}

/** 触发浏览器下载一个 .json 文件（兼容非安全上下文 / 文件协议） */
export function downloadJson(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 生成默认导出文件名，如 xyzw-groups-20260929-2146.json */
export function defaultExportFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(
    d.getDate(),
  )}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `xyzw-groups-${stamp}.json`;
}

/**
 * 解析并校验导入文本。
 * @throws {Error} 内容非法时抛出可读错误
 */
export function parseGroupExport(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("内容为空，请粘贴导出的分组文本");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("不是合法的 JSON：" + (e && e.message ? e.message : e));
  }
  if (!data || data.schema !== GROUP_EXPORT_SCHEMA) {
    throw new Error("不是本工具导出的分组文件（schema 不匹配）");
  }
  if (
    !Array.isArray(data.tokenGroups) &&
    !Array.isArray(data.mgGroups) &&
    !Array.isArray(data.saltFieldTeams)
  ) {
    throw new Error("文件中没有可导入的分组或队伍数据");
  }
  return data;
}

/**
 * 合并一组「简单分组」（tokenGroups / mgGroups 共用同一结构）。
 * @returns {{added:number, updated:number, skipped:number}}
 */
function mergeSimpleGroups(targetRef, incoming, { mode }) {
  const result = { added: 0, updated: 0, skipped: 0 };
  if (!Array.isArray(incoming) || incoming.length === 0) return result;

  const existing = targetRef.value || [];
  const byName = new Map(existing.map((g) => [normalizeName(g.name), g]));
  const byId = new Map(existing.map((g) => [g.id, g]));
  const next = mode === "overwrite" ? [] : [...existing];

  for (const g of incoming) {
    if (!g || !normalizeName(g.name)) {
      result.skipped++;
      continue;
    }
    const match = byId.get(g.id) || byName.get(normalizeName(g.name));

    if (match && mode !== "overwrite") {
      match.color = g.color ?? match.color;
      match.tokenKeys = Array.isArray(g.tokenKeys)
        ? [...g.tokenKeys]
        : match.tokenKeys || [];
      if ("updatedAt" in match) match.updatedAt = nowIso();
      result.updated++;
    } else {
      if (match && mode === "overwrite") {
        const idx = next.findIndex((x) => x.id === match.id);
        if (idx >= 0) next.splice(idx, 1);
      }
      next.push({
        id: g.id || "group_" + Date.now() + Math.random().toString(36).slice(2),
        name: normalizeName(g.name),
        color: g.color || "#1677ff",
        tokenKeys: Array.isArray(g.tokenKeys) ? [...g.tokenKeys] : [],
        createdAt: g.createdAt || nowIso(),
        updatedAt: nowIso(),
      });
      result.added++;
    }
  }
  targetRef.value = next;
  return result;
}

/**
 * 将解析后的分组对象写回本机（合并策略）。
 * @param {object} payload - parseGroupExport 的返回值
 * @param {{mode?: "merge" | "overwrite"}} [opts]
 * @returns {object} 导入报告
 */
export function applyGroupImport(payload, { mode = "merge" } = {}) {
  const report = {
    mode,
    addedTokenGroups: 0,
    updatedTokenGroups: 0,
    skippedTokenGroups: 0,
    addedMgGroups: 0,
    updatedMgGroups: 0,
    skippedMgGroups: 0,
    addedTeams: 0,
    updatedTeams: 0,
    skippedTeams: 0,
    unresolvedLeaders: [],
  };

  /* ---------------- 批量日常分组 ---------------- */
  const r1 = mergeSimpleGroups(tokenGroups, payload.tokenGroups, { mode });
  report.addedTokenGroups = r1.added;
  report.updatedTokenGroups = r1.updated;
  report.skippedTokenGroups = r1.skipped;

  /* ---------------- token 管理独立分组 ---------------- */
  const r2 = mergeSimpleGroups(mgGroups, payload.mgGroups, { mode });
  report.addedMgGroups = r2.added;
  report.updatedMgGroups = r2.updated;
  report.skippedMgGroups = r2.skipped;

  /* ---------------- 盐场队伍 ---------------- */
  const incomingTeams = Array.isArray(payload.saltFieldTeams)
    ? payload.saltFieldTeams
    : [];
  if (incomingTeams.length) {
    // 本机：稳定键 → token id（用于反查队长）
    const keyToTokenId = new Map();
    for (const t of gameTokens.value || []) {
      const key = getStableTokenKey(t.serverId, t.roleId);
      if (key) keyToTokenId.set(key, t.id);
    }
    // 本机：队长稳定键 → 现有队伍（用于合并去重，保证一队长一队）
    const existingTeams = getTeams() || [];
    const tokenById = new Map(
      (gameTokens.value || []).map((t) => [t.id, t]),
    );
    const existingKeyToTeam = new Map();
    for (const t of existingTeams) {
      const lead = tokenById.get(t.leaderTokenId);
      if (!lead) continue;
      const k = getStableTokenKey(lead.serverId, lead.roleId);
      if (k) existingKeyToTeam.set(k, t);
    }

    const next = mode === "overwrite" ? [] : [...existingTeams];

    for (const t of incomingTeams) {
      if (!t || !normalizeKey(t.leaderKey)) {
        report.skippedTeams++;
        continue;
      }
      const leaderTokenId = keyToTokenId.get(normalizeKey(t.leaderKey));
      if (!leaderTokenId) {
        report.unresolvedLeaders.push({
          leaderKey: normalizeKey(t.leaderKey),
          teamName: t.name || "",
        });
        report.skippedTeams++;
        continue;
      }
      const newTeam = {
        id: t.id || makeTeamId(t.legionId ?? "unknown", leaderTokenId),
        legionId: t.legionId ?? null,
        leaderTokenId,
        name: t.name || "队伍",
        enabled: t.enabled !== false,
        memberRoleIds: Array.isArray(t.memberRoleIds)
          ? [...t.memberRoleIds]
          : [],
        mobile: !!t.mobile,
        mode: t.mode || "immediate",
      };

      const match = existingKeyToTeam.get(normalizeKey(t.leaderKey));
      if (match && mode !== "overwrite") {
        Object.assign(match, newTeam);
        report.updatedTeams++;
      } else {
        if (match && mode === "overwrite") {
          const idx = next.findIndex((x) => x.id === match.id);
          if (idx >= 0) next.splice(idx, 1);
        }
        next.push(newTeam);
        report.addedTeams++;
      }
    }
    setTeams(next);
  }

  return report;
}
