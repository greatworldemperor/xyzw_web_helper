import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCombLoginUrl,
  createHortorDeviceProfile,
  createHortorLoginBin,
  createMobileLoginPayload,
  createVerificationPayload,
  decodeHortorPayload,
  encodeHortorPayload,
  loginWithMobileCode,
  requestMobileVerificationCode,
} from "../src/utils/hortorLogin.js";
import { g_utils } from "../src/utils/bonProtocol.js";

const profile = createHortorDeviceProfile({
  now: 1700000000000,
  uuid: "11111111-2222-4333-8444-555555555555",
  androidId: "0123456789abcdef",
});

test("Hortor codec matches the existing wire format and round trips UTF-8", () => {
  const payload = {
    gameId: "xyzwapp",
    tp: "app-mobile",
    smsCode: "000000",
    mobile: "13000000000",
  };
  const encoded = encodeHortorPayload(payload);

  assert.equal(
    encoded,
    "LzBzIw8xW1QRAxpdCy8rXjMaGnQrKgsnP1keKxZ8Ngh/XH8CNxwQFxoUcSUPJB1cDlFGMzMBewI6fnQ6NyB/QQUMCxB+JyY7J3IZOzgPQzgRWg47bAQZWgcOCQN4JQ04Iy8qGT9xBxEuC3RX",
  );
  assert.deepEqual(JSON.parse(decodeHortorPayload(encoded)), payload);

  const unicodePayload = { message: "登录成功" };
  assert.deepEqual(
    JSON.parse(decodeHortorPayload(encodeHortorPayload(unicodePayload))),
    unicodePayload,
  );
});

test("verification and login payloads preserve one device identity", () => {
  const verification = createVerificationPayload("13000000000", profile);
  const login = createMobileLoginPayload("13000000000", "000000", profile);
  const loginUrl = new URL(
    createCombLoginUrl(profile, 1700000000123),
    "https://example.test",
  );

  assert.equal(verification.accountNum, login.mobile);
  assert.equal(
    verification.activeLoginMatchId,
    login.activeLoginMatchId,
  );
  assert.equal(verification.distinctId, login.distinctId);
  assert.equal(verification.androidId, login.androidId);
  assert.equal(login.tp, "app-mobile");
  assert.equal(loginUrl.searchParams.get("timestamp"), "1700000000");
  assert.equal(
    loginUrl.searchParams.get("deviceUniqueId"),
    profile.distinctId,
  );
});

test("verification response controls the resend countdown", async () => {
  const result = await requestMobileVerificationCode(
    "13000000000",
    profile,
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            meta: { errCode: 0, errMsg: "success" },
            data: {
              sendSuccess: true,
              waitSecond: 120,
              msg: "消息可正常发送",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  );

  assert.equal(result.waitSecond, 120);
});

test("mobile login returns combUser and creates a compatible login bin", async () => {
  const combUser = {
    encryptCombUser: "example-encrypted-user",
    sign: "0123456789abcdef0123456789abcdef",
    timestamp: 1700000001,
  };
  let sentPayload;
  const result = await loginWithMobileCode("13000000000", "000000", profile, {
    fetchImpl: async (_url, options) => {
      sentPayload = JSON.parse(decodeHortorPayload(options.body));
      return new Response(
        JSON.stringify({
          meta: { errCode: 0, errMsg: "success" },
          data: { combUser, combSdkInfo: { loginTp: "app-mobile" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const bin = createHortorLoginBin(result.combUser, profile);
  const encryptedBytes = new Uint8Array(bin).slice();
  const decoded = g_utils.parse(bin.slice(0))._raw;

  assert.equal(sentPayload.mobile, "13000000000");
  assert.equal(sentPayload.smsCode, "000000");
  assert.equal(decoded.platform, "hortor");
  assert.equal(decoded.platformExt, "mix");
  assert.equal(decoded.deviceUniqueId, profile.distinctId);
  assert.deepEqual(JSON.parse(decoded.info), combUser);
  assert.deepEqual(new Uint8Array(bin), encryptedBytes);
});
