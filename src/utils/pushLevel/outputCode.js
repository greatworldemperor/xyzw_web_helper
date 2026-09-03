import CryptoJS from "crypto-js";
import { jsonExtStringify } from "./jsonExt.js";

const RESULT_KEYS = [
  "id",
  "isWin",
  "seed",
  "totalFrame",
  "version",
  "battleVersion",
  "inputCode",
  "outputCode",
  "log",
  "sponsor",
  "accept",
  "type",
  "round",
  "isTimeout",
  "statistic",
];

const TEAM_KEYS = [
  "roleId",
  "name",
  "headImg",
  "avatarFrame",
  "power",
  "teamInfo",
  "ext",
];

const MEMBER_KEYS = [
  "heroId",
  "color",
  "level",
  "order",
  "index",
  "rage",
  "club",
  "slot",
  "star",
  "damage",
  "takeDamage",
  "treatment",
  "hp",
  "energy",
  "skin",
  "skinName",
  "type",
  "maxAttr",
  "statistic",
  "skillDamage",
  "skillTreatment",
  "enchantMap",
];

const DEFAULT_MAX_ATTR = { 2: 0, 3: 0, 4: 0 };
const DEFAULT_AVATAR_FRAME = { id: 0, expire: 0 };

const hasOwn = (value, key) =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, key);

const firstDefined = (value, keys, fallback) => {
  for (const key of keys) {
    if (hasOwn(value, key) && value[key] !== undefined) return value[key];
  }

  return fallback;
};

const cloneMapOrObject = (value, fallback) => {
  if (value instanceof Map) return new Map(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }

  return fallback;
};

const normalizeAvatarFrame = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  if (value !== undefined && value !== null && value !== "") {
    return { id: value, expire: 0 };
  }
  return { ...DEFAULT_AVATAR_FRAME };
};

const getMembers = (team) => {
  if (Array.isArray(team)) return team;
  if (!team || typeof team !== "object") return [];

  for (const key of ["teamInfo", "members", "roles", "heroes"]) {
    if (Array.isArray(team[key])) return team[key];
  }

  const numericKeys = Object.keys(team)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right));
  return numericKeys.map((key) => team[key]);
};

const normalizeMember = (source = {}, fallbackIndex = 0) => {
  const member = {
    heroId: firstDefined(source, ["heroId", "heroID", "id"], 0),
    color: firstDefined(source, ["color"], 0),
    level: firstDefined(source, ["level"], 0),
    order: firstDefined(source, ["order"], 0),
    index: firstDefined(source, ["index"], fallbackIndex),
    rage: firstDefined(source, ["rage"], 0),
    club: firstDefined(source, ["club"], 0),
    slot: firstDefined(
      source,
      ["slot", "position", "index"],
      fallbackIndex,
    ),
    star: firstDefined(source, ["star"], 0),
    damage: firstDefined(source, ["damage"], 0),
    takeDamage: firstDefined(source, ["takeDamage"], 0),
    treatment: firstDefined(source, ["treatment"], 0),
    hp: firstDefined(source, ["hp"], 0),
    energy: firstDefined(source, ["energy"], 0),
    skin: firstDefined(source, ["skin", "skinId"], 0),
    skinName: firstDefined(source, ["skinName"], ""),
    type: firstDefined(source, ["type"], 0),
    maxAttr: cloneMapOrObject(source.maxAttr, { ...DEFAULT_MAX_ATTR }),
    statistic: cloneMapOrObject(source.statistic, {}),
    skillDamage: cloneMapOrObject(source.skillDamage, {}),
    skillTreatment: cloneMapOrObject(source.skillTreatment, {}),
    enchantMap: cloneMapOrObject(source.enchantMap, {}),
  };

  return Object.fromEntries(MEMBER_KEYS.map((key) => [key, member[key]]));
};

const normalizeTeam = (source, membersOverride) => {
  const team = source && typeof source === "object" ? source : {};
  const members = membersOverride ?? getMembers(team);
  const normalized = {
    roleId: firstDefined(team, ["roleId", "id"], ""),
    name: firstDefined(team, ["name", "roleName"], ""),
    headImg: firstDefined(team, ["headImg", "headIcon"], ""),
    avatarFrame: normalizeAvatarFrame(
      firstDefined(team, ["avatarFrame", "avatarFrameId"]),
    ),
    power: firstDefined(team, ["power", "combatPower"], 0),
    teamInfo: Array.from(members, (member, index) =>
      normalizeMember(member, index),
    ),
    ext: {
      curHP: firstDefined(team.ext, ["curHP", "currentHP"], 0),
    },
  };

  return Object.fromEntries(TEAM_KEYS.map((key) => [key, normalized[key]]));
};

const getBattleDataValue = (battleData, keys, fallback) =>
  firstDefined(battleData, keys, fallback);

const normalizeResultFlag = (value) => {
  if (typeof value !== "boolean") {
    throw new TypeError("isWin must be a boolean");
  }
  return value;
};

const createOrderedResult = ({
  battleData,
  isWin = true,
  sponsor,
  accept,
  sponsorMembers,
  acceptMembers,
  totalFrame = 0,
  battleVersion = "",
  inputCode = "",
  outputCode = "",
  log = "",
  type,
  round = 0,
  isTimeout = 0,
  statistic = {},
}) => {
  if (!battleData || typeof battleData !== "object") {
    throw new TypeError("battleData is required");
  }

  const seed = getBattleDataValue(battleData, ["randomSeed", "seed"]);
  if (seed === undefined) throw new TypeError("battleData.randomSeed is required");
  isWin = normalizeResultFlag(isWin);

  const leftTeam = sponsor ?? battleData.sponsor ?? battleData.leftTeam;
  const rightTeam = accept ?? battleData.accept ?? battleData.rightTeam;
  const result = {
    id: getBattleDataValue(battleData, ["id"], 0),
    isWin,
    seed,
    totalFrame,
    version: getBattleDataValue(battleData, ["version"], 0),
    battleVersion,
    inputCode,
    outputCode,
    log,
    sponsor: normalizeTeam(leftTeam, sponsorMembers),
    accept: normalizeTeam(rightTeam, acceptMembers),
    type: type ?? getBattleDataValue(battleData, ["mode", "type"], 0),
    round,
    isTimeout,
    statistic: cloneMapOrObject(statistic, {}),
  };

  return Object.fromEntries(RESULT_KEYS.map((key) => [key, result[key]]));
};

export const md5String = (value) => CryptoJS.MD5(value).toString();

export const buildInputCode = (battleData) => {
  if (!battleData || typeof battleData !== "object") {
    throw new TypeError("battleData is required");
  }

  const sanitized = {};
  for (const key of Object.keys(battleData)) {
    if (key === "leftTeams" || key === "rightTeams") {
      sanitized[key] = undefined;
    } else if (key === "result") {
      sanitized[key] = null;
    } else {
      sanitized[key] = battleData[key];
    }
  }

  if (!hasOwn(sanitized, "result")) sanitized.result = null;
  return md5String(jsonExtStringify(sanitized));
};

export const createClientBattleResult = (options) =>
  createOrderedResult(options);

export const buildOutputCode = (options) => {
  const result = createClientBattleResult({
    ...options,
    outputCode: "",
  });
  const serialized = jsonExtStringify(result);
  const outputCode = md5String(serialized);

  return { result, serialized, outputCode };
};

export const outputCodeSchema = {
  resultKeys: [...RESULT_KEYS],
  teamKeys: [...TEAM_KEYS],
  memberKeys: [...MEMBER_KEYS],
};

export default buildOutputCode;