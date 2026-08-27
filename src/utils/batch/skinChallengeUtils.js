const skinChallengeTargetTypes = [1, 2, 3, 4, 5, 6];

export const skinChallengeTargetOptions = skinChallengeTargetTypes.map(
  (targetType) => ({
    label: `BOSS ${targetType}`,
    value: targetType,
  }),
);

export const defaultSkinChallengeTargets = [];

export const normalizeSkinChallengeTargets = (value) => {
  if (!Array.isArray(value)) return [...defaultSkinChallengeTargets];

  return [
    ...new Set(
      value
        .map((targetType) => Number(targetType))
        .filter((targetType) => skinChallengeTargetTypes.includes(targetType)),
    ),
  ].sort((firstType, secondType) => firstType - secondType);
};

export const selectSkinChallengeTargets = (
  openTowerTypes,
  selectedTargetTypes,
  isTowerCleared,
) => {
  const selectedTargets = new Set(
    normalizeSkinChallengeTargets(selectedTargetTypes),
  );

  return (Array.isArray(openTowerTypes) ? openTowerTypes : []).filter(
    (towerType) =>
      selectedTargets.has(Number(towerType)) && !isTowerCleared(towerType),
  );
};