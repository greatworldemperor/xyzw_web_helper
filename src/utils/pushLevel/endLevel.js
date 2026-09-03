const getBattleData = (value) => {
  if (!value || typeof value !== "object") return null;
  return value.battleData ?? value.body?.battleData ?? value;
};

const getLevelId = (battleData) =>
  battleData?.options?.levelId ?? battleData?.levelId;

export const normalizeBattleTime = (value) => {
  const battleTime = Number(value);
  if (!Number.isInteger(battleTime) || battleTime < 0 || battleTime > 1000000) {
    throw new TypeError(
      "battleTime must be an integer between 0 and 1000000 ticks",
    );
  }
  return battleTime;
};

const normalizeWaveTimes = (value, name) => {
  if (value === undefined || value === null) return [[]];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length === 0) return [[]];

  const isSingleWave = value.every((item) => Number.isFinite(item));
  if (isSingleWave) return [value.slice()];

  if (!value.every((wave) => Array.isArray(wave))) {
    throw new TypeError(`${name} must contain tick arrays`);
  }

  return value.map((wave) => wave.slice());
};

export const extractStartLevel = (response) => {
  const battleData = getBattleData(response);
  if (!battleData || typeof battleData !== "object") {
    throw new TypeError("Fight_StartLevelResp does not contain battleData");
  }

  const levelId = getLevelId(battleData);
  if (levelId === undefined || levelId === null) {
    throw new TypeError("battleData.options.levelId is required");
  }

  const seed = battleData.randomSeed ?? battleData.seed;
  if (seed === undefined || seed === null) {
    throw new TypeError("battleData.randomSeed is required");
  }

  return { battleData, levelId, seed };
};

export const buildEndLevelPayload = ({
  battleData,
  levelId,
  battleTime,
  tapTimes,
  autoTapTimes,
  outputCode,
  log = "",
}) => {
  if (!battleData || typeof battleData !== "object") {
    throw new TypeError("battleData is required");
  }
  if (levelId === undefined || levelId === null) {
    levelId = getLevelId(battleData);
  }
  if (levelId === undefined || levelId === null) {
    throw new TypeError("levelId is required");
  }
  battleTime = normalizeBattleTime(battleTime);
  if (typeof outputCode !== "string" || !/^[a-f0-9]{32}$/i.test(outputCode)) {
    throw new TypeError("outputCode must be a 32-character hexadecimal string");
  }

  return {
    levelId,
    battleTime,
    tapTimes: normalizeWaveTimes(tapTimes, "tapTimes"),
    autoTapTimes: normalizeWaveTimes(autoTapTimes, "autoTapTimes"),
    outputCode: outputCode.toLowerCase(),
    log: typeof log === "string" ? log : "",
  };
};

export default buildEndLevelPayload;