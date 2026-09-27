const express = require("express");
const cheerio = require("cheerio");
const { init, parse } = require("es-module-lexer");

const app = express();
const port = process.env.PORT || 8080;
const allowedOrigin = "https://alangamertorre.github.io";
const proxyOrigin = (
  process.env.PUBLIC_URL ||
  "https://web-proxy-backend-production.up.railway.app"
).replace(/\/$/, "");

app.use((request, response, next) => {
  response.vary("Origin");

  if (request.get("Origin") === allowedOrigin) {
    response.set("Access-Control-Allow-Origin", allowedOrigin);
  }

  if (request.method === "OPTIONS") {
    response.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    response.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With",
    );
    return response.sendStatus(204);
  }

  next();
});

app.get(["/", "/health"], (request, response) => {
  response.status(200).json({ status: "ok" });
});

const parseRequestUrl = (request) => {
  if (request.query.url) return new URL(request.query.url);

  const match = request.path.match(/^\/proxy\/(https?)\/([^/]+)(\/.*)?$/);
  if (!match) throw new Error("La URL no es válida.");

  return new URL(
    `${match[1]}://${match[2]}${match[3] || "/"}${request.url.slice(request.path.length)}`,
  );
};

const makeProxyUrl = (destination) =>
  `${proxyOrigin}/proxy/${destination.protocol.slice(0, -1)}/${destination.host}${destination.pathname}${destination.search}`;

const rewriteModuleImports = async (source, destination) => {
  await init;
  const [imports] = parse(source);
  const replacements = imports
    .filter(
      ({ n }) =>
        typeof n === "string" &&
        /^(?:[a-z][a-z\d+.-]*:|\/\/|\.{1,2}\/|\/)/i.test(n),
    )
    .map(({ s, e, n }) => {
      try {
        const importedUrl = new URL(n, destination);
        if (!["http:", "https:"].includes(importedUrl.protocol)) return null;
        return { start: s, end: e, value: makeProxyUrl(importedUrl) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.start - left.start);

  for (const replacement of replacements) {
    source =
      source.slice(0, replacement.start) +
      replacement.value +
      source.slice(replacement.end);
  }
  return source;
};

const proxyRequest = async (request, response) => {
  let destination;

  try {
    destination = parseRequestUrl(request);
  } catch {
    return response.status(400).json({ error: "La URL no es válida." });
  }

  if (!["http:", "https:"].includes(destination.protocol)) {
    return response
      .status(400)
      .json({ error: "Solo se permiten URLs HTTP y HTTPS." });
  }

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      const lowerName = name.toLowerCase();
      if (
        [
          "host",
          "connection",
          "content-length",
          "accept-encoding",
          "origin",
          "referer",
          "cookie",
        ].includes(lowerName) ||
        lowerName.startsWith("sec-fetch-")
      )
        continue;
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (value) headers.set(name, value);
    }
    headers.set("Origin", destination.origin);
    headers.set("Referer", destination.href);

    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body: ["GET", "HEAD", "OPTIONS"].includes(request.method)
        ? undefined
        : request.body,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    const contentType = upstream.headers.get("content-type") || "";
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml")
    ) {
      const document = cheerio.load(await upstream.text());
      document(
        'meta[http-equiv="Content-Security-Policy"], meta[http-equiv="X-Frame-Options"]',
      ).remove();
      document("base").remove();
      document("head").prepend(
        document("<base>").attr("href", destination.href),
      );

      const bridge = `(() => {
        const siteBase = ${JSON.stringify(destination.href)};
        const proxyUrl = (value) => {
          let target;
          try { target = new URL(value, siteBase); } catch { return value; }
          if (!['http:', 'https:'].includes(target.protocol) || target.origin === ${JSON.stringify(proxyOrigin)}) return value;
          return ${JSON.stringify(proxyOrigin)} + '/proxy/' + target.protocol.slice(0, -1) + '/' + target.host + target.pathname + target.search;
        };
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          return originalOpen.call(this, method, proxyUrl(url), ...args);
        };
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
          if (input instanceof Request) {
            return originalFetch.call(this, new Request(proxyUrl(input.url), input), init);
          }
          return originalFetch.call(this, proxyUrl(input), init);
        };
      })();`;
      document("head").prepend(document("<script>").text(bridge));

      document("[src], [href], [poster], [action]").each((_, element) => {
        const tag = element.name;
        const attribute =
          tag === "form"
            ? "action"
            : tag === "video"
              ? "poster"
              : [
                    "script",
                    "img",
                    "iframe",
                    "source",
                    "audio",
                    "video",
                    "input",
                    "embed",
                    "track",
                    "link",
                  ].includes(tag)
                ? tag === "link"
                  ? "href"
                  : "src"
                : "";
        if (!attribute) return;

        try {
          const resource = new URL(
            document(element).attr(attribute),
            destination,
          );
          if (["http:", "https:"].includes(resource.protocol)) {
            document(element).attr(attribute, makeProxyUrl(resource));
          }
        } catch {
          // Conserva valores especiales que no sean URLs web.
        }
      });

      document("a[href], area[href]").each((_, element) => {
        try {
          const link = new URL(document(element).attr("href"), destination);
          if (["http:", "https:"].includes(link.protocol)) {
            document(element).attr("href", makeProxyUrl(link));
          }
        } catch {
          // Conserva enlaces especiales como mailto:.
        }
      });

      response.status(upstream.status).type("html").send(document.html());
      return;
    }

    if (
      contentType.includes("javascript") ||
      contentType.includes("ecmascript")
    ) {
      const source = await upstream.text();
      const rewritten = await rewriteModuleImports(source, destination);
      response.status(upstream.status).type(contentType).send(rewritten);
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    for (const [name, value] of upstream.headers) {
      if (
        [
          "content-encoding",
          "content-length",
          "transfer-encoding",
          "content-security-policy",
          "x-frame-options",
          "set-cookie",
        ].includes(name.toLowerCase())
      )
        continue;
      response.set(name, value);
    }
    response.status(upstream.status).send(body);
  } catch (error) {
    const timedOut = error.name === "TimeoutError";
    response.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "El sitio tardó demasiado en responder."
        : "No se pudo conectar con el sitio de destino.",
    });
  }
};

app.all("/proxy", express.raw({ type: "*/*", limit: "25mb" }), proxyRequest);
app.all(
  /^\/proxy\/(https?)\/([^/]+)(\/.*)?$/,
  express.raw({ type: "*/*", limit: "25mb" }),
  proxyRequest,
);

app.listen(port, "0.0.0.0", () => {
  console.log("Proxy HTTP activo en el puerto " + port);
});
