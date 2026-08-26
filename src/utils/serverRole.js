export const decodeServerRoleId = (serverId) => {
  let normalizedServerId = Number(serverId);
  let roleIndex = 0;

  if (normalizedServerId >= 2000000) {
    roleIndex = 2;
    normalizedServerId -= 2000000;
  } else if (normalizedServerId >= 1000000) {
    roleIndex = 1;
    normalizedServerId -= 1000000;
  }

  return {
    serverNumber: normalizedServerId - 27,
    roleIndex,
  };
};

export const formatImportedRoleName = (
  template,
  { name, roleId, serverId },
) => {
  const { serverNumber, roleIndex } = decodeServerRoleId(serverId);
  const roleName = name || `角色_${roleId}`;

  return (template || "{name}-{index}-{id}")
    .replace(/{name}/g, () => roleName)
    .replace(/{index}/g, () => String(roleIndex))
    .replace(/{id}/g, () => String(roleId))
    .replace(/{server}/g, () => `${serverNumber}服`);
};
