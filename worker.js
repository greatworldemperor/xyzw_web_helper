const smsRateLimits = new Map();
const SMS_RESEND_INTERVAL_MS = 120000;
const SMS_REQUEST_MAX_BYTES = 4096;
const COMB_LOGIN_REQUEST_MAX_BYTES = 16384;
const SMS_RESPONSE_MAX_BYTES = 65536;

function getRequestOrigin(request) {
  const origin = request.headers.get('Origin');
  try {
    return origin ? new URL(origin).origin : null;
  } catch {
    return null;
  }
}

async function hashMobile(mobile) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(mobile),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function validateSmsProxyRequest(request, url) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  if (getRequestOrigin(request) !== url.origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > SMS_REQUEST_MAX_BYTES) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const bodyText = await request.clone().text();
  if (new TextEncoder().encode(bodyText).byteLength > SMS_REQUEST_MAX_BYTES) {
    return new Response('Payload Too Large', { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (
    !/^1[3-9]\d{9}$/.test(payload.accountNum || '') ||
    payload.gameId !== 'xyzwapp' ||
    payload.verifyCodeTp !== 'login'
  ) {
    return new Response('Invalid request', { status: 400 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `${ip}:${await hashMobile(payload.accountNum)}`;
  const now = Date.now();
  const retryAfterMs = SMS_RESEND_INTERVAL_MS - (now - (smsRateLimits.get(rateLimitKey) || 0));
  if (retryAfterMs > 0) {
    return new Response(
      JSON.stringify({
        meta: { errCode: 429, errMsg: '验证码发送过于频繁' },
        data: { sendSuccess: false, waitSecond: Math.ceil(retryAfterMs / 1000) },
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
        },
      },
    );
  }

  smsRateLimits.set(rateLimitKey, now);
  if (smsRateLimits.size > 10000) {
    for (const [key, timestamp] of smsRateLimits) {
      if (now - timestamp >= SMS_RESEND_INTERVAL_MS) smsRateLimits.delete(key);
    }
  }
  return null;
}

async function validateCombLoginProxyRequest(request, url) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (getRequestOrigin(request) !== url.origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!/^text\/plain(?:\s*;|$)/i.test(contentType)) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  const params = url.searchParams;
  const validPackageNames = new Set([
    'com.hortor.games.xyzw',
    'com.hortorgames.xyzw',
  ]);
  if (
    params.get('gameId') !== 'xyzwapp' ||
    params.get('version') !== 'android-4.2.1-cn-release' ||
    params.get('cryptVersion') !== '1.1.0' ||
    params.get('gameTp') !== 'app' ||
    params.get('system') !== 'android' ||
    !validPackageNames.has(params.get('packageName')) ||
    !/^\d{10,13}$/.test(params.get('timestamp') || '') ||
    !/^DID-[0-9a-f-]{36}$/i.test(params.get('deviceUniqueId') || '')
  ) {
    return new Response('Invalid request', { status: 400 });
  }

  const declaredLength = Number(request.headers.get('Content-Length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > COMB_LOGIN_REQUEST_MAX_BYTES
  ) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const body = await request.clone().arrayBuffer();
  if (
    body.byteLength === 0 ||
    body.byteLength > COMB_LOGIN_REQUEST_MAX_BYTES
  ) {
    return new Response(
      body.byteLength === 0 ? 'Invalid request' : 'Payload Too Large',
      { status: body.byteLength === 0 ? 400 : 413 },
    );
  }
  return null;
}

async function createLoginProxyResponse(response, corsHeaders) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return new Response(JSON.stringify({ error: 'Invalid upstream response' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > SMS_RESPONSE_MAX_BYTES) {
    return new Response(JSON.stringify({ error: 'Upstream response too large' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > SMS_RESPONSE_MAX_BYTES) {
    return new Response(JSON.stringify({ error: 'Upstream response too large' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };

    const isLoginProxy =
      url.pathname.startsWith('/api/hortor-ucenter') ||
      url.pathname.startsWith('/api/hortor');
    const loginCorsHeaders = {
      'Access-Control-Allow-Origin': url.origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    // Handle OPTIONS request
    if (request.method === 'OPTIONS') {
      if (isLoginProxy && getRequestOrigin(request) !== url.origin) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(null, {
        headers: isLoginProxy ? loginCorsHeaders : corsHeaders,
      });
    }

    // Proxy configuration
    const proxies = [
      {
        prefix: '/api/hortor-ucenter',
        target: 'https://ucenter-app-server.hortorgames.com',
        allowedPath: '/ucenter-app-server/api/v1/login/verify/code',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Web Login Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36',
          'Accept': 'application/json',
          'Host': 'ucenter-app-server.hortorgames.com',
          'Connection': 'keep-alive',
          'Content-Type': 'application/json; charset=utf-8'
        }
      },
      {
        prefix: '/api/weixin-long',
        target: 'https://long.open.weixin.qq.com',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 7.0; Mi-4c Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/53.0.2785.49 Mobile MQQBrowser/6.2 TBS/043632 Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/WIFI Language/zh_CN',
          'Accept': '*/*',
          'Referer': 'https://open.weixin.qq.com/'
        }
      },
      {
        prefix: '/api/weixin',
        target: 'https://open.weixin.qq.com',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 7.0; Mi-4c Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/53.0.2785.49 Mobile MQQBrowser/6.2 TBS/043632 Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/WIFI Language/zh_CN',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Referer': 'https://open.weixin.qq.com/'
        }
      },
      {
        prefix: '/api/hortor',
        target: 'https://comb-platform.hortorgames.com',
        allowedPath: '/comb-login-server/api/v1/login',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0.4638.74 Mobile Safari/537.36',
          'Accept': '*/*',
          'Host': 'comb-platform.hortorgames.com',
          'Connection': 'keep-alive',
          'Content-Type': 'text/plain; charset=utf-8',
          'Origin': 'https://open.weixin.qq.com',
          'Referer': 'https://open.weixin.qq.com/'
        }
      }
    ].sort((a, b) => b.prefix.length - a.prefix.length); // Sort by length descending to match longest prefix first

    // Find matching proxy
    const proxy = proxies.find(p => url.pathname.startsWith(p.prefix));

    if (proxy) {
      const upstreamPath = url.pathname.replace(proxy.prefix, '') || '/';
      if (proxy.allowedPath && upstreamPath !== proxy.allowedPath) {
        return new Response('Not Found', { status: 404, headers: corsHeaders });
      }

      if (proxy.prefix === '/api/hortor-ucenter') {
        const rejection = await validateSmsProxyRequest(request, url);
        if (rejection) return rejection;
      } else if (proxy.prefix === '/api/hortor') {
        const rejection = await validateCombLoginProxyRequest(request, url);
        if (rejection) return rejection;
      }

      // Construct new URL
      const targetUrl = new URL(proxy.target);
      targetUrl.pathname = upstreamPath;
      targetUrl.search = url.search;

      // Prepare request headers
      const newHeaders = new Headers(request.headers);
      
      // Override headers based on proxy config
      Object.entries(proxy.headers).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      // Special handling for Host header (Cloudflare might override it, but good to set intention)
      if (proxy.headers.Host) {
        newHeaders.set('Host', proxy.headers.Host);
      }

      const requestBody =
        proxy.prefix === '/api/hortor-ucenter' || proxy.prefix === '/api/hortor'
          ? await request.arrayBuffer()
          : request.body;

      // Create new request
      const newRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: requestBody,
        redirect: 'follow'
      });

      try {
        const response = await fetch(newRequest);

        if (
          proxy.prefix === '/api/hortor-ucenter' ||
          proxy.prefix === '/api/hortor'
        ) {
          return createLoginProxyResponse(response, loginCorsHeaders);
        }
        
        // Re-create response to add CORS headers
        const newResponse = new Response(response.body, response);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          newResponse.headers.set(key, value);
        });
        
        return newResponse;
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
    }

    // Serve static assets (Cloudflare Pages)
    // If env.ASSETS is available (e.g. in Cloudflare Pages Functions), use it to fetch static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Default response for non-proxy paths
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
