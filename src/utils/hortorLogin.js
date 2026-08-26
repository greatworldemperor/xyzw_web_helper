import { g_utils } from "./bonProtocol.js";

export const HORTOR_GAME_ID = "xyzwapp";
export const HORTOR_GAME_TYPE = "app";
export const HORTOR_CHANNEL = "android";
export const HORTOR_PACKAGE_NAME = "com.hortor.games.xyzw";
export const HORTOR_SDK_VERSION = "4.2.1-cn-release";
export const HORTOR_CLIENT_VERSION = "android-4.2.1-cn-release";
export const HORTOR_CRYPT_VERSION = "1.1.0";

const DEVICE_PROFILE_STORAGE_KEY = "hortor-mobile-device-profile-v1";
const SIGN_PRINT =
  "E6:F7:FE:A9:EC:8E:24:D0:4F:2A:32:50:28:78:E1:C5:5E:70:81:13";
const PAYLOAD_KEY =
  "eW7ir7i9sgPt5RdneMbjr7VvRZjy5I0vz2TPgOyJuba2zNGSIYGteC3VjJG5rJQAgKLlV6DOH6FZvlcen5RidkN47LQRkH9r4VUdV71RmlHSucVCjiwGiuqoN6mfZEob88ng8VRyFLQMHJIu1id2oEeUWGbluAKb3gAo05EUynYvdYOIzIUagxZ4Tat2ooo0OfZlh7swZHEP6prlhiYE1Mms0E1MEMb69Rx8fsXFeIE8OzmxyXNKAROFDbQErSAXar60p31wMvnknnNOXiZpVFoR7uz7mubJv8FJuGX94AGKaPqAgRB2S0PtpCrXis5bJRkWwHxy8iAh1sM1ft96wAycIEjikzdw5J5rJaaDEqHeGB3NHHQuxPpKuUQTovfpQNyNqwwsORkpsQf5yjd3CHECX8oAMHDgZYM3cWA7E0RqCE4Ojlbtf6IFlDQlaCEUnKbqstmnSaxQ3XZJS8Vkk1tjhye034fxMzCtYT6hMtUmFYTcUJifArFzjNCVYCIi9Ug2r2htSFDDHgNNd9kUj2pdhKGm69HBRMSsZmokMCePo10iwZGf7oV9vNnkS0rV9LSSSu8OeoGPEN2xv5I7Z5KwQ1AIWjTC3mLh5h8fHBe1u8HNVXtX4zIUErEEsXdhx4JkE0TcFwjfx1lKLYRPXE40y8Nh6CZq2gnzXYWnelJI9MVfj8BTK4DFajVB" +
  "jGrrIPv0iBr4wa055jTTQcxCHLnse0G81ZP3JxkLMQms6wLfJg3cgLj1PHqbrNH7bH6WPlNdLy5aLOnkknr5FfgeDjwq47nG7wJX5EJTlNlsizOq7V2M2VBz556R14Hmxm8mVk2QTUUzzaPWSyI1Ef1zqfchUdp9OuvOwVX8oqyNgEWK2oGiJsd5mjLJftHonZ1RIxs4GWUjCFhoOiO2JtJyOAyDyS774RgwFvH4zgQyfWoq906rNO2k1PDH9eg6P0trYEhnFWAHO0zUgRePGCnUy6GPOROMJ0PENjlmjGzckUlUfW7YpNjFYFJSBasY4goKEb2OSqH8WisOew3iSAttq2pmiylmTkYWLZ5OiNFsBDdDiNPgK6w91i0ok0tbyMyJ56twP3qzIrp88qgPctTS4yd1QT0tndm1MkvYQz6E0kerzXvor8nOjxz612c9Cjnzqyg3bztFop29nI0P4FP3v3YLytnuub0AByYlB6XpA9QdBQ2TDaCCvrKkPu24xWV6ZE8Jbf3zVOe2pn9zlGlllh5dJm09PW3Z452Tw5KEFkyhvItWrxyNA87axNl2LdrSo4QLxsrCNuAiQtiunxG4V9hbg6YEWvoqfAns4zeLzsH8nYWcIxlxAKGhcZPXjuovBWPM2gGSLgzqWJ2fOOyM6";

export class HortorLoginError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "HortorLoginError";
    this.code = code;
    this.status = status;
  }
}

const bytesToBinary = (bytes) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return binary;
};

const binaryToBytes = (binary) => {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const encodeUtf8Base64 = (text) =>
  btoa(bytesToBinary(new TextEncoder().encode(text)));

const decodeUtf8Base64 = (text) =>
  new TextDecoder().decode(binaryToBytes(atob(text)));

const xorPayload = (source) => {
  let keyIndex = PAYLOAD_KEY.length >> 1;
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    if (keyIndex >= PAYLOAD_KEY.length) keyIndex = 0;
    output += String.fromCharCode(
      source.charCodeAt(index) ^ PAYLOAD_KEY.charCodeAt(keyIndex),
    );
    keyIndex += 1;
  }

  return output;
};

export const encodeHortorPayload = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const encodedJson = encodeUtf8Base64(text);
  return btoa(xorPayload(encodedJson));
};

export const decodeHortorPayload = (payload) => {
  const encodedJson = xorPayload(atob(payload));
  return decodeUtf8Base64(encodedJson);
};

const randomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const bytesToHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const createUuid = () => {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createHortorDeviceProfile = ({
  now = Date.now(),
  uuid = createUuid(),
  androidId = bytesToHex(randomBytes(8)),
} = {}) => {
  const distinctId = `DID-${uuid}`;
  return {
    distinctId,
    activeLoginMatchId: `${now}_${distinctId}`,
    androidId,
    system: "Android 12",
    model: "Web Login",
    brand: "Browser",
  };
};

const isValidDeviceProfile = (profile) =>
  profile &&
  typeof profile.distinctId === "string" &&
  /^DID-[0-9a-f-]{36}$/i.test(profile.distinctId) &&
  typeof profile.activeLoginMatchId === "string" &&
  profile.activeLoginMatchId.endsWith(`_${profile.distinctId}`) &&
  typeof profile.androidId === "string" &&
  /^[0-9a-f]{16}$/i.test(profile.androidId);

export const getOrCreateHortorDeviceProfile = (
  storage = globalThis.localStorage,
) => {
  if (storage) {
    try {
      const stored = JSON.parse(storage.getItem(DEVICE_PROFILE_STORAGE_KEY));
      if (isValidDeviceProfile(stored)) return stored;
    } catch {
      // Replace malformed or inaccessible storage with a fresh local profile.
    }
  }

  const profile = createHortorDeviceProfile();
  try {
    storage?.setItem(DEVICE_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Private browsing can deny localStorage; the current component still reuses this object.
  }
  return profile;
};

export const isValidChineseMobile = (mobile) => /^1[3-9]\d{9}$/.test(mobile);
export const isValidSmsCode = (smsCode) => /^\d{6}$/.test(smsCode);

const getSystemInfo = (profile) =>
  JSON.stringify({
    system: profile.system,
    hortorSDKVersion: HORTOR_SDK_VERSION,
    model: profile.model,
    brand: profile.brand,
  });

const getCommonPayload = (profile) => ({
  gameId: HORTOR_GAME_ID,
  gameTp: HORTOR_GAME_TYPE,
  sysInfo: getSystemInfo(profile),
  activeLoginMatchId: profile.activeLoginMatchId,
  channel: HORTOR_CHANNEL,
  distinctId: profile.distinctId,
  oaidThirdSdk: "",
  ipv6: "",
  packageName: HORTOR_PACKAGE_NAME,
  signPrint: SIGN_PRINT,
  androidId: profile.androidId,
  oaId: "",
  oaid: "",
});

export const createVerificationPayload = (mobile, profile) => ({
  gameId: HORTOR_GAME_ID,
  gameTp: HORTOR_GAME_TYPE,
  accountNum: mobile,
  sysInfo: getSystemInfo(profile),
  activeLoginMatchId: profile.activeLoginMatchId,
  channel: HORTOR_CHANNEL,
  verifyCodeTp: "login",
  distinctId: profile.distinctId,
  oaidThirdSdk: "",
  ipv6: "",
  limit: true,
  packageName: HORTOR_PACKAGE_NAME,
  signPrint: SIGN_PRINT,
  androidId: profile.androidId,
  oaId: "",
  oaid: "",
});

export const createMobileLoginPayload = (mobile, smsCode, profile) => ({
  ...getCommonPayload(profile),
  smsCode,
  mobile,
  tp: "app-mobile",
});

export const createCombLoginUrl = (profile, now = Date.now()) => {
  const params = new URLSearchParams({
    gameId: HORTOR_GAME_ID,
    timestamp: String(Math.floor(now / 1000)),
    version: HORTOR_CLIENT_VERSION,
    cryptVersion: HORTOR_CRYPT_VERSION,
    gameTp: HORTOR_GAME_TYPE,
    system: "android",
    deviceUniqueId: profile.distinctId,
    packageName: HORTOR_PACKAGE_NAME,
  });
  return `/api/hortor/comb-login-server/api/v1/login?${params}`;
};

const parseJsonResponse = async (response, fallbackMessage) => {
  let json;
  try {
    json = await response.json();
  } catch {
    throw new HortorLoginError(fallbackMessage, { status: response.status });
  }

  const code = json?.meta?.errCode;
  if (!response.ok || code !== 0) {
    throw new HortorLoginError(
      json?.meta?.errMsg || json?.data?.msg || fallbackMessage,
      { code, status: response.status },
    );
  }
  return json;
};

export const requestMobileVerificationCode = async (
  mobile,
  profile,
  { fetchImpl = fetch, signal } = {},
) => {
  if (!isValidChineseMobile(mobile)) {
    throw new HortorLoginError("请输入正确的手机号");
  }

  const response = await fetchImpl(
    "/api/hortor-ucenter/ucenter-app-server/api/v1/login/verify/code",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(createVerificationPayload(mobile, profile)),
      signal,
    },
  );
  const json = await parseJsonResponse(response, "验证码发送失败");
  if (json.data?.sendSuccess !== true) {
    throw new HortorLoginError(json.data?.msg || "验证码发送失败", {
      code: json.meta?.errCode,
      status: response.status,
    });
  }

  return {
    waitSecond: Math.max(1, Number(json.data.waitSecond) || 120),
    message: json.data.msg || "验证码已发送",
  };
};

export const loginWithMobileCode = async (
  mobile,
  smsCode,
  profile,
  { fetchImpl = fetch, signal } = {},
) => {
  if (!isValidChineseMobile(mobile)) {
    throw new HortorLoginError("请输入正确的手机号");
  }
  if (!isValidSmsCode(smsCode)) {
    throw new HortorLoginError("请输入 6 位短信验证码");
  }

  const payload = createMobileLoginPayload(mobile, smsCode, profile);
  const response = await fetchImpl(createCombLoginUrl(profile), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: encodeHortorPayload(payload),
    signal,
  });
  const json = await parseJsonResponse(response, "手机号登录失败");
  const combUser = json.data?.combUser;
  if (
    typeof combUser?.encryptCombUser !== "string" ||
    typeof combUser?.sign !== "string" ||
    typeof combUser?.timestamp !== "number"
  ) {
    throw new HortorLoginError("登录响应缺少账号凭据", {
      status: response.status,
    });
  }

  return { combUser, sdkInfo: json.data?.combSdkInfo ?? null };
};

export const createHortorLoginBin = (
  combUser,
  profile,
  serverId = null,
) =>
  g_utils.encode(
    {
      platform: "hortor",
      oriPlatform: "",
      platformExt: "mix",
      info: JSON.stringify(combUser),
      serverId,
      scene: 0,
      referrerInfo: "",
      deviceUniqueId: profile.distinctId,
    },
    "lx",
  );
