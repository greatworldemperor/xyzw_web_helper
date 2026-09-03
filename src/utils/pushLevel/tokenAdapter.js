import { PushLevelScheduler } from "./scheduler.js";

const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_END_TIMEOUT_MS = 15000;

const levelCandidates = (response) => [
  response?.nextLevelId,
  response?.nextLevel,
  response?.levelId,
  response?.role?.levelId,
  response?.role?.level,
  response?.body?.nextLevelId,
  response?.body?.nextLevel,
  response?.body?.levelId,
  response?.body?.role?.levelId,
  response?.body?.role?.level,
  response?.currLevel,
  response?.body?.currLevel,
];

const asLevelNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const extractEndLevelResponseLevelId = (response) => {
  for (const candidate of levelCandidates(response)) {
    const levelId = asLevelNumber(candidate);
    if (levelId !== null) return levelId;
  }

  return null;
};

export const confirmEndLevelProgress = (
  response,
  { completedLevelId, expectedNextLevelId } = {},
) => {
  const completed = asLevelNumber(completedLevelId);
  const expected =
    expectedNextLevelId === undefined
      ? completed === null
        ? null
        : completed + 1
      : asLevelNumber(expectedNextLevelId);
  const responseLevelId = extractEndLevelResponseLevelId(response);

  if (expected === null) {
    throw new Error("无法确认主线关卡：completedLevelId 无效");
  }
  if (responseLevelId === null) {
    throw new Error("无法确认主线关卡：响应缺少下一关 levelId");
  }
  if (responseLevelId !== expected) {
    throw new Error(
      `主线关卡未按顺序推进：期望 ${expected}，服务器返回 ${responseLevelId}`,
    );
  }

  return {
    confirmed: true,
    completedLevelId: completed,
    expectedNextLevelId: expected,
    responseLevelId,
  };
};

const assertTokenStore = (tokenStore) => {
  if (!tokenStore || typeof tokenStore.sendMessageWithPromise !== "function") {
    throw new TypeError("tokenStore.sendMessageWithPromise must be a function");
  }
};

export const createPushLevelTokenAdapter = (
  tokenStore,
  {
    allowSubmit = false,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    endTimeoutMs = DEFAULT_END_TIMEOUT_MS,
  } = {},
) => {
  assertTokenStore(tokenStore);

  const startLevel = (tokenId) =>
    tokenStore.sendMessageWithPromise(
      tokenId,
      "fight_startlevel",
      {},
      startTimeoutMs,
    );

  if (allowSubmit !== true) return { startLevel };

  const submit = (payload, context) => {
    if (!context?.tokenId) {
      throw new TypeError("submit context.tokenId is required");
    }
    return tokenStore.sendMessageWithPromise(
      context.tokenId,
      "fight_endlevel",
      payload,
      endTimeoutMs,
    );
  };

  const confirm = (response, _preview, context) =>
    confirmEndLevelProgress(response, {
      completedLevelId: context?.levelId,
    });

  return { startLevel, submit, confirm };
};

export const createPushLevelScheduler = ({
  tokenStore,
  tokenId,
  buildResult,
  allowSubmit = false,
  settings,
  randomUnit,
  onEvent,
  startTimeoutMs,
  endTimeoutMs,
} = {}) => {
  if (typeof buildResult !== "function") {
    throw new TypeError("buildResult must be a function");
  }

  const adapter = createPushLevelTokenAdapter(tokenStore, {
    allowSubmit,
    startTimeoutMs,
    endTimeoutMs,
  });
  const submitOptions = adapter.submit
    ? { submit: adapter.submit, confirm: adapter.confirm }
    : {};

  return new PushLevelScheduler({
    tokenId,
    startLevel: adapter.startLevel,
    buildResult,
    settings,
    randomUnit,
    onEvent,
    ...submitOptions,
  });
};

export default createPushLevelScheduler;