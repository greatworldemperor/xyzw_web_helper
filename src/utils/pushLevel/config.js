import { normalizeBattleTime } from "./endLevel.js";

export const DEFAULT_BATTLE_CONFIG = Object.freeze({
  battleTime: 447,
  isWin: true,
});

export const normalizeBattleConfig = ({
  battleTime = DEFAULT_BATTLE_CONFIG.battleTime,
  isWin = DEFAULT_BATTLE_CONFIG.isWin,
} = {}) => {
  if (typeof isWin !== "boolean") {
    throw new TypeError("isWin must be a boolean");
  }

  return Object.freeze({
    battleTime: normalizeBattleTime(battleTime),
    isWin,
  });
};

export default normalizeBattleConfig;