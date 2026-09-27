const express = require("express");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 8080;
const allowedOrigin = "https://alangamertorre.github.io";

// Permite que la interfaz de GitHub Pages consulte este backend.
app.use((request, response, next) => {
  response.vary("Origin");

  if (request.get("Origin") === allowedOrigin) {
    response.set("Access-Control-Allow-Origin", allowedOrigin);
  }

  if (request.method === "OPTIONS") {
    response.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Content-Type");
    return response.sendStatus(204);
  }

  next();
});

app.get("/proxy", async (request, response) => {
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
    const upstream = await fetch(destination, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "WebRelay/1.0" },
    });
    const contentType = upstream.headers.get("content-type") || "";

    if (!upstream.ok) {
      return response.status(upstream.status).json({
        error: "El sitio de destino respondió con " + upstream.status + ".",
      });
    }

    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      return response
        .status(415)
        .json({ error: "El destino no devolvió una página HTML." });
    }

    const document = cheerio.load(await upstream.text());
    document(
      'meta[http-equiv="Content-Security-Policy"], meta[http-equiv="X-Frame-Options"]',
    ).remove();
    document("base").remove();
    document("head").prepend(document("<base>").attr("href", destination.href));

    document("a[href], area[href]").each((_, element) => {
      try {
        const link = new URL(document(element).attr("href"), destination);
        if (["http:", "https:"].includes(link.protocol)) {
          document(element).attr(
            "href",
            `/proxy?url=${encodeURIComponent(link.href)}`,
          );
        }
      } catch {
        // Deja intactos enlaces que no sean URLs HTTP o HTTPS.
      }
    });

    response.type("html").send(document.html());
  } catch (error) {
    const timedOut = error.name === "TimeoutError";
    response.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "El sitio tardó demasiado en responder."
        : "No se pudo conectar con el sitio de destino.",
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log("Proxy HTTP activo en el puerto " + port);
});
