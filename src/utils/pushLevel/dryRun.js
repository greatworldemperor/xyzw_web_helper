import { buildEndLevelPayload, extractStartLevel } from "./endLevel.js";
import { buildOutputCode } from "./outputCode.js";
import { normalizeBattleConfig } from "./config.js";

const hasTeamMembers = (team) =>
  team && typeof team === "object" && Array.isArray(team.teamInfo);

export const buildPushLevelDryRun = ({
  startResponse,
  sponsor,
  accept,
  battleTime,
  tapTimes,
  autoTapTimes,
  isWin = true,
  resultOptions = {},
  log = "",
}) => {
  const start = extractStartLevel(startResponse);
  if (!hasTeamMembers(sponsor) || !hasTeamMembers(accept)) {
    throw new TypeError(
      "dry-run requires explicit sponsor.teamInfo and accept.teamInfo templates",
    );
  }

  const battleConfig = normalizeBattleConfig({
    battleTime,
    isWin: resultOptions.isWin === undefined ? isWin : resultOptions.isWin,
  });

  const generated = buildOutputCode({
    battleData: start.battleData,
    sponsor,
    accept,
    ...resultOptions,
    isWin: battleConfig.isWin,
  });
  const payload = buildEndLevelPayload({
    battleData: start.battleData,
    levelId: start.levelId,
    battleTime: battleConfig.battleTime,
    tapTimes,
    autoTapTimes,
    outputCode: generated.outputCode,
    log,
  });

  return {
    ...start,
    result: generated.result,
    serialized: generated.serialized,
    outputCode: generated.outputCode,
    payload,
    battleConfig,
  };
};

export default buildPushLevelDryRun;