import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../worker.js";

const appOrigin = "https://app.example";
const smsPath =
  "/api/hortor-ucenter/ucenter-app-server/api/v1/login/verify/code";
const combLoginPath =
  "/api/hortor/comb-login-server/api/v1/login" +
  "?gameId=xyzwapp" +
  "&timestamp=1700000000" +
  "&version=android-4.2.1-cn-release" +
  "&cryptVersion=1.1.0" +
  "&gameTp=app" +
  "&system=android" +
  "&deviceUniqueId=DID-11111111-2222-4333-8444-555555555555" +
  "&packageName=com.hortor.games.xyzw";

const createSmsRequest = ({
  mobile = "13912345678",
  method = "POST",
  origin = appOrigin,
  contentType = "application/json; charset=utf-8",
  ip = "192.0.2.1",
  path = smsPath,
} = {}) => {
  const headers = {
    Origin: origin,
    "Content-Type": contentType,
    "CF-Connecting-IP": ip,
  };
  const body =
    method === "POST"
      ? JSON.stringify({
          accountNum: mobile,
          gameId: "xyzwapp",
          verifyCodeTp: "login",
        })
      : undefined;
  return new Request(`${appOrigin}${path}`, { method, headers, body });
};

const createCombLoginRequest = ({
  method = "POST",
  origin = appOrigin,
  contentType = "text/plain; charset=utf-8",
  path = combLoginPath,
} = {}) =>
  new Request(`${appOrigin}${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": contentType },
    body: method === "POST" ? "QUJDRA==" : undefined,
  });

test("login proxies enforce their boundaries and forward valid requests", async () => {
  assert.equal(
    (await worker.fetch(createSmsRequest({ method: "GET" }), {}, {})).status,
    405,
  );
  assert.equal(
    (
      await worker.fetch(
        createSmsRequest({ path: "/api/hortor-ucenter/not-allowed" }),
        {},
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await worker.fetch(
        createSmsRequest({ origin: "https://attacker.example" }),
        {},
        {},
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await worker.fetch(
        createSmsRequest({ origin: "not a valid origin" }),
        {},
        {},
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await worker.fetch(
        createSmsRequest({ contentType: "text/plain" }),
        {},
        {},
      )
    ).status,
    415,
  );

  const originalFetch = globalThis.fetch;
  const forwardedRequests = [];
  globalThis.fetch = async (request) => {
    forwardedRequests.push(request);
    return new Response(
      JSON.stringify({
        meta: { errCode: 0, errMsg: "success" },
        data: { sendSuccess: true, waitSecond: 120 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const response = await worker.fetch(createSmsRequest(), {}, {});
    assert.equal(response.status, 200);
    assert.equal(forwardedRequests.length, 1);
    assert.equal(
      forwardedRequests[0].url,
      "https://ucenter-app-server.hortorgames.com/ucenter-app-server/api/v1/login/verify/code",
    );
    assert.equal(forwardedRequests[0].method, "POST");

    const throttled = await worker.fetch(createSmsRequest(), {}, {});
    assert.equal(throttled.status, 429);
    assert.equal(forwardedRequests.length, 1);
    assert.equal(throttled.headers.get("Retry-After"), "120");

    assert.equal(
      (
        await worker.fetch(
          createCombLoginRequest({ origin: "https://attacker.example" }),
          {},
          {},
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await worker.fetch(
          createCombLoginRequest({
            path: "/api/hortor/comb-login-server/api/v1/not-allowed",
          }),
          {},
          {},
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await worker.fetch(
          createCombLoginRequest({ contentType: "application/json" }),
          {},
          {},
        )
      ).status,
      415,
    );

    const acceptedPreflight = await worker.fetch(
      createCombLoginRequest({ method: "OPTIONS" }),
      {},
      {},
    );
    assert.equal(acceptedPreflight.status, 200);
    assert.equal(
      acceptedPreflight.headers.get("Access-Control-Allow-Origin"),
      appOrigin,
    );
    assert.equal(
      (
        await worker.fetch(
          createCombLoginRequest({
            method: "OPTIONS",
            origin: "https://attacker.example",
          }),
          {},
          {},
        )
      ).status,
      403,
    );

    const combResponse = await worker.fetch(createCombLoginRequest(), {}, {});
    assert.equal(combResponse.status, 200);
    assert.equal(combResponse.headers.get("Access-Control-Allow-Origin"), appOrigin);
    assert.equal(forwardedRequests.length, 2);
    assert.equal(
      new URL(forwardedRequests[1].url).pathname,
      "/comb-login-server/api/v1/login",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});