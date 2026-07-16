import http from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_TARGET = "https://enedis.stanislas.cloud";

export function redirectLocation(requestTarget: string | undefined, target = DEFAULT_TARGET) {
  const targetURL = new URL(target);
  const basePath = targetURL.pathname.replace(/\/$/, "");
  const pathAndQuery = typeof requestTarget === "string" && requestTarget.startsWith("/") ? requestTarget : "/";
  return `${targetURL.origin}${basePath}${pathAndQuery}`;
}

export function createRedirectServer({ target = process.env.REDIRECT_TARGET || DEFAULT_TARGET } = {}) {
  return http.createServer((request, response) => {
    const requestURL = new URL(request.url || "/", "http://railway.invalid");
    if (requestURL.pathname === "/healthz") {
      const body = "ok\n";
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(body);
      return;
    }

    const location = redirectLocation(request.url, target);
    const body = `Temporary redirect to ${location}\n`;
    response.writeHead(307, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "text/plain; charset=utf-8",
      Location: location,
    });
    response.end(body);
  });
}

function start() {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const server = createRedirectServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Railway redirect listening on :${port}, target=${process.env.REDIRECT_TARGET || DEFAULT_TARGET}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
