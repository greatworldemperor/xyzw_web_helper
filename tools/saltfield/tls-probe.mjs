// GitHub IP × TLS 可达性探针（TCP 通 ≠ TLS 通，必须真握手并校验证书）
import tls from "node:tls";

const IPS = [
  "140.82.121.4",
  "140.82.114.4",
  "140.82.112.3",
  "140.82.113.4",
  "20.205.243.166",
  "20.27.177.113",
  "20.200.245.247",
];

const probe = (ip) =>
  new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect(
      {
        host: ip,
        port: 443,
        servername: "github.com", // SNI + 证书校验都用真域名
        rejectUnauthorized: true, // 证书不合法就算失败
        timeout: 6000,
      },
      () => {
        const ok = socket.authorized;
        const ms = Date.now() - started;
        socket.destroy();
        resolve({ ip, ok, ms, why: ok ? "TLS OK" : socket.authorizationError });
      },
    );
    socket.on("error", (e) => resolve({ ip, ok: false, ms: Date.now() - started, why: e.code || e.message }));
    socket.on("timeout", () => { socket.destroy(); resolve({ ip, ok: false, ms: 6000, why: "TIMEOUT" }); });
  });

const results = [];
for (const ip of IPS) results.push(await probe(ip));
const ok = results.filter((r) => r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✅" : "❌"} ${r.ip.padEnd(17)} ${String(r.ms).padStart(5)}ms  ${r.why}`);
}
console.log(`\n可用 ${ok.length}/${results.length}：${ok.map((r) => r.ip).join(" ")}`);
