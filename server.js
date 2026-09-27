const express = require("express");
const cheerio = require("cheerio");

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

app.all(
  "/proxy",
  express.raw({ type: "*/*", limit: "25mb" }),
  async (request, response) => {
    let destination;

    try {
      destination = new URL(request.query.url);
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
        if (
          [
            "host",
            "connection",
            "content-length",
            "accept-encoding",
            "origin",
            "referer",
            "cookie",
          ].includes(name.toLowerCase()) ||
          name.toLowerCase().startsWith("sec-fetch-")
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
        body: ["GET", "HEAD"].includes(request.method)
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
        const proxyOrigin = ${JSON.stringify(proxyOrigin)};
        const siteBase = ${JSON.stringify(destination.href)};
        const proxyUrl = (value) => {
          let target;
          try { target = new URL(value, siteBase); } catch { return value; }
          if (!['http:', 'https:'].includes(target.protocol) || target.origin === proxyOrigin) return value;
          return proxyOrigin + '/proxy?url=' + encodeURIComponent(target.href);
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

        document("a[href], area[href], form[action]").each((_, element) => {
          const attribute = element.name === "form" ? "action" : "href";
          try {
            const link = new URL(
              document(element).attr(attribute),
              destination,
            );
            if (["http:", "https:"].includes(link.protocol)) {
              document(element).attr(
                attribute,
                `${proxyOrigin}/proxy?url=${encodeURIComponent(link.href)}`,
              );
            }
          } catch {
            // Deja intactos los destinos que no sean URLs HTTP o HTTPS.
          }
        });

        response.status(upstream.status).type("html").send(document.html());
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
  },
);

app.listen(port, "0.0.0.0", () => {
  console.log("Proxy HTTP activo en el puerto " + port);
});
