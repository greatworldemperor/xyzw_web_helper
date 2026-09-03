const asObject = (value) =>
  value && typeof value === "object" ? value : {};

const DEFAULT_AVATAR_FRAME = { id: 0, expire: 0 };

const firstDefined = (value, keys, fallback) => {
  const source = asObject(value);
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
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

const getRole = (roleResponse) => {
  const source = asObject(roleResponse);
  const candidates = [source.body?.role, source.role, source.body, source].filter(
    (candidate) => candidate && typeof candidate === "object",
  );
  return (
    candidates.find(
      (candidate) =>
        candidate.heroes && typeof candidate.heroes === "object",
    ) || candidates[0] || {}
  );
};

const getPresetCandidates = (presetResponse) => {
  const source = asObject(presetResponse);
  return [source.body?.presetTeamInfo, source.presetTeamInfo, source.body, source].filter(
    (candidate) => candidate && typeof candidate === "object",
  );
};

const readPresetMembers = (candidate) => {
  const root = asObject(candidate);
  const nested = asObject(root.presetTeamInfo ?? root);
  const useTeamId =
    Number(firstDefined(root, ["useTeamId"], firstDefined(nested, ["useTeamId"], 1))) || 1;
  const dictionary = asObject(nested.presetTeamInfo ?? nested);
  const selected = dictionary[String(useTeamId)] ?? dictionary[useTeamId];
  const teamInfo = selected?.teamInfo ?? selected?.heroes ?? selected;

  if (Array.isArray(teamInfo)) return teamInfo;
  if (!teamInfo || typeof teamInfo !== "object") return [];

  const members = Object.keys(teamInfo)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => teamInfo[key]);
  if (members.length) return members;

  if (teamInfo.heroId !== undefined || teamInfo.id !== undefined) {
    return [teamInfo];
  }

  return [];
};

const getPresetTeamInfo = (presetResponse) => {
  for (const candidate of getPresetCandidates(presetResponse)) {
    const members = readPresetMembers(candidate);
    if (members.length) return members;
  }
  return [];
};

const getRoleHeroes = (roleResponse, presetResponse) => {
  const role = getRole(roleResponse);
  const heroes = role.heroes;
  const heroMap = asObject(heroes);
  const presetMembers = getPresetTeamInfo(presetResponse).filter((member) => {
    const heroId = firstDefined(member, ["heroId", "id"], null);
    return heroId !== null && heroId !== undefined && heroId !== "" && heroId !== 0;
  });

  if (!presetMembers.length) return [];
  return presetMembers.map((presetMember, index) => {
    const heroId = firstDefined(presetMember, ["heroId", "id"], 0);
    const roleHero = heroMap[String(heroId)] ?? heroMap[heroId] ?? {};
    return {
      ...asObject(roleHero),
      ...asObject(presetMember),
      heroId,
      index: firstDefined(presetMember, ["index", "position"], index),
      slot: firstDefined(presetMember, ["slot", "position"], index),
    };
  });
};

const getEnemyMembers = (battleData) => {
  const rightTeam = asObject(battleData?.rightTeam);
  const enemyContainer = rightTeam.team ?? rightTeam.teamInfo ?? rightTeam;
  if (!enemyContainer || typeof enemyContainer !== "object") return [];

  const members = Array.isArray(enemyContainer)
    ? enemyContainer
    : Object.keys(enemyContainer)
        .filter((key) => /^\d+$/.test(key))
        .sort((left, right) => Number(left) - Number(right))
        .map((key) => enemyContainer[key]);

  return members
    .map((member, index) => {
    const source = asObject(member);
    const position = firstDefined(
      source,
      ["slot", "position", "index"],
      index,
    );
    return {
      ...source,
      heroId: firstDefined(source, ["heroId", "id"], 0),
      slot: position,
      index: firstDefined(source, ["index"], position),
    };
    })
    .filter((member) => member.heroId !== 0 && member.heroId !== "");
};

const getRoleTeam = (roleResponse, roleHeroes) => {
  const role = getRole(roleResponse);
  return {
    roleId: firstDefined(role, ["roleId", "id"], 0),
    name: firstDefined(role, ["name", "roleName"], ""),
    headImg: firstDefined(role, ["headImg", "headIcon"], ""),
    avatarFrame: normalizeAvatarFrame(
      firstDefined(role, ["avatarFrame", "avatarFrameId"]),
    ),
    power: firstDefined(role, ["power", "fighting"], 0),
    teamInfo: roleHeroes,
    ext: { curHP: firstDefined(role, ["curHP", "currentHP"], 0) },
  };
};

const getEnemyTeam = (battleData, enemyTemplate = {}) => {
  const rightTeam = asObject(battleData?.rightTeam);
  const template = asObject(enemyTemplate);
  return {
    roleId: firstDefined(template, ["roleId", "id"], firstDefined(rightTeam, ["roleId", "id"], 0)),
    name: firstDefined(template, ["name", "roleName"], firstDefined(rightTeam, ["name"], "")),
    headImg: firstDefined(template, ["headImg", "headIcon"], firstDefined(rightTeam, ["headImg"], "")),
    avatarFrame: normalizeAvatarFrame(
      firstDefined(template, ["avatarFrame", "avatarFrameId"]),
    ),
    power: firstDefined(template, ["power", "combatPower"], firstDefined(rightTeam, ["power"], 0)),
    teamInfo: getEnemyMembers(battleData),
    ext: { curHP: firstDefined(template, ["curHP", "currentHP"], 0) },
  };
};

export const buildResultTemplates = ({
  battleData,
  roleResponse,
  presetResponse,
  enemyTemplate,
} = {}) => {
  if (!battleData || typeof battleData !== "object") {
    throw new TypeError("battleData is required");
  }

  const roleHeroes = getRoleHeroes(roleResponse, presetResponse);
  const enemyMembers = getEnemyMembers(battleData);
  if (!roleHeroes.length) {
    throw new TypeError("role/preset response does not contain the active team");
  }
  if (!enemyMembers.length) {
    throw new TypeError("battleData does not contain enemy team members");
  }

  return {
    sponsor: getRoleTeam(roleResponse, roleHeroes),
    accept: getEnemyTeam(battleData, enemyTemplate),
  };
};

export default buildResultTemplates;