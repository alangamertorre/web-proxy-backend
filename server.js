const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

function makeProxyUrl(value, sourceUrl, proxyOrigin) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return value;

  try {
    const destination = new URL(trimmed, sourceUrl);
    if (!["http:", "https:"].includes(destination.protocol)) return value;
    return `${proxyOrigin}/proxy?url=${encodeURIComponent(destination.href)}`;
  } catch {
    return value;
  }
}

function rewriteCss(css, sourceUrl, proxyOrigin) {
  return css
    .replace(
      /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi,
      (match, quote, quoted, unquoted) => {
        const value = (quoted ?? unquoted ?? "").trim();
        const proxied = makeProxyUrl(value, sourceUrl, proxyOrigin);
        return `url("${proxied.replaceAll('"', "%22")}")`;
      },
    )
    .replace(
      /(@import\s+)(["'])([^"']+)\2/gi,
      (match, prefix, quote, value) => {
        return `${prefix}${quote}${makeProxyUrl(value, sourceUrl, proxyOrigin)}${quote}`;
      },
    );
}

function rewriteHtml(html, sourceUrl, proxyOrigin) {
  const $ = cheerio.load(html);
  $("base").remove();

  $("[href], [src], [action], [poster], object[data]").each((_, element) => {
    for (const attribute of ["href", "src", "action", "poster", "data"]) {
      const value = $(element).attr(attribute);
      if (value)
        $(element).attr(attribute, makeProxyUrl(value, sourceUrl, proxyOrigin));
    }
  });

  $("[style]").each((_, element) => {
    const style = $(element).attr("style");
    $(element).attr("style", rewriteCss(style, sourceUrl, proxyOrigin));
  });

  $("style").each((_, element) => {
    $(element).text(rewriteCss($(element).text(), sourceUrl, proxyOrigin));
  });

  return $.html();
}

async function readLimitedBody(body) {
  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        const error = new Error("La respuesta supera el límite de 10 MB");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

app.get("/", (_req, res) => {
  res.json({
    service: "web-proxy",
    status: "ready",
    usage: "/proxy?url=https%3A%2F%2Fexample.com",
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/proxy", async (req, res) => {
  let destination;
  try {
    if (typeof req.query.url !== "string")
      throw new Error("Falta el parámetro url");
    destination = new URL(req.query.url);
    if (!["http:", "https:"].includes(destination.protocol)) {
      throw new Error("Solo se permiten direcciones HTTP y HTTPS");
    }
    if (destination.username || destination.password) {
      throw new Error("La dirección no puede incluir credenciales");
    }
  } catch (error) {
    return res
      .status(400)
      .json({ error: error.message || "La URL no es válida" });
  }

  try {
    const upstream = await fetch(destination, {
      headers: {
        accept: req.get("accept") || "*/*",
        "user-agent": req.get("user-agent") || "WebProxy/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!upstream.body) return res.sendStatus(upstream.status);

    const contentLength = Number(upstream.headers.get("content-length"));
    if (contentLength > MAX_RESPONSE_BYTES) {
      await upstream.body.cancel();
      return res
        .status(413)
        .json({ error: "La respuesta supera el límite de 10 MB" });
    }
    const body = await readLimitedBody(upstream.body);
    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";
    let responseBody = body;
    const proxyOrigin = process.env.PUBLIC_URL
      ? new URL(process.env.PUBLIC_URL).origin
      : `${req.protocol}://${req.get("host")}`;

    if (contentType.includes("text/html")) {
      responseBody = Buffer.from(
        rewriteHtml(body.toString("utf8"), destination.href, proxyOrigin),
      );
    } else if (contentType.includes("text/css")) {
      responseBody = Buffer.from(
        rewriteCss(body.toString("utf8"), destination.href, proxyOrigin),
      );
    }

    res.status(upstream.status);
    res.set("content-type", contentType);
    res.set("cache-control", "no-store");
    return res.send(responseBody);
  } catch (error) {
    console.error("Error al solicitar el destino:", error.message);
    if (error.statusCode === 413) {
      return res.status(413).json({ error: error.message });
    }
    return res
      .status(502)
      .json({ error: "No se pudo obtener la página solicitada" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy HTTP activo en el puerto ${PORT}`);
});
