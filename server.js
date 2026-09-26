const express = require("express");
const path = require("path");
const app = express();

// OBLIGATORIO PARA RAILWAY: Escuchar en el puerto que te asigne la plataforma dinámicamente
const PORT = process.env.PORT || 3000;

// Servir la interfaz pública (HTML/CSS)
app.use(express.static(path.join(__dirname, "public")));

// Capturar la URL solicitada
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Falta el parámetro "url"');
  }

  try {
    // Railway descarga la web bloqueada por ti
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const contentType = response.headers.get("content-type");
    let body = await response.text();

    // Si es HTML, inyectamos la etiqueta <base> para arreglar las rutas relativas de CSS/Imágenes
    if (contentType && contentType.includes("text/html")) {
      const urlObj = new URL(targetUrl);
      const origin = urlObj.origin;

      // Esto hace que el iframe busque los archivos directamente en la web original
      body = body.replace("<head>", `<head><base href="${origin}/">`);
    }

    res.set("Content-Type", contentType || "text/html");
    res.send(body);
  } catch (error) {
    res
      .status(500)
      .send(`Error en el servidor proxy de Railway: ${error.message}`);
  }
});

// Enlazar a 0.0.0.0 es necesario para que Railway redirija el tráfico público a tu app
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy web activo en el puerto ${PORT}`);
});
