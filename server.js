// Express expone el servidor HTTP y sus rutas.
const express = require("express");
// Cheerio permite analizar y modificar el HTML recibido del sitio remoto.
const cheerio = require("cheerio");
// El lexer localiza imports de JavaScript sin tener que interpretar el programa.
const { init, parse } = require("es-module-lexer");

// Creamos una única aplicación Express para todas las peticiones.
const app = express();
// Railway proporciona PORT; 8080 permite ejecutar el proyecto localmente.
const port = process.env.PORT || 8080;
// Solo este frontend queda autorizado para realizar peticiones CORS al proxy.
const allowedOrigin = "https://alangamertorre.github.io";
// PUBLIC_URL permite cambiar la dirección pública sin modificar el código.
// Quitamos la barra final para construir rutas /proxy de forma consistente.
const proxyOrigin = (
  process.env.PUBLIC_URL ||
  "https://web-proxy-backend-production.up.railway.app"
).replace(/\/$/, "");

// Este middleware configura CORS antes de llegar a cualquier ruta.
app.use((request, response, next) => {
  // Indica a las cachés que la respuesta puede variar según Origin.
  response.vary("Origin");

  // No abrimos CORS a cualquier sitio: únicamente al frontend conocido.
  if (request.get("Origin") === allowedOrigin) {
    response.set("Access-Control-Allow-Origin", allowedOrigin);
  }

  // El navegador envía OPTIONS antes de algunas peticiones cross-origin.
  if (request.method === "OPTIONS") {
    // Declaramos los métodos que el navegador puede solicitar al proxy.
    response.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, aOPTIONS",
    );
    // Declaramos las cabeceras que aceptamos en la petición real.
    response.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With",
    );
    // 204 confirma el preflight sin enviar un cuerpo innecesario.
    return response.sendStatus(204);
  }

  // Las demás peticiones continúan hacia su ruta correspondiente.
  next();
});

// Endpoint de salud para comprobar que el proceso está vivo.
app.get(["/", "/health"], (request, response) => {
  // Una respuesta JSON sencilla facilita los health checks automáticos.
  response.status(200).json({ status: "ok" });
});

// Convierte las dos formas de URL que entiende el proxy en una URL estándar.
const parseRequestUrl = (request) => {
  // Forma explícita: /proxy?url=https://ejemplo.com/ruta.
  if (request.query.url) return new URL(request.query.url);

  // Forma legible: /proxy/https/ejemplo.com/ruta.
  const match = request.path.match(/^\/proxy\/(https?)\/([^/]+)(\/.*)?$/);
  // Si ninguna forma coincide, la petición no contiene un destino válido.
  if (!match) throw new Error("La URL no es válida.");

  // request.url también conserva la query string que no aparece en path.
  return new URL(
    `${match[1]}://${match[2]}${match[3] || "/"}${request.url.slice(request.path.length)}`,
  );
};

// Representa una URL remota como una URL que vuelve a entrar por este proxy.
const makeProxyUrl = (destination) =>
  `${proxyOrigin}/proxy/${destination.protocol.slice(0, -1)}/${destination.host}${destination.pathname}${destination.search}`;

// Reescribe imports relativos o absolutos encontrados en módulos JS.
const rewriteModuleImports = async (source, destination) => {
  // es-module-lexer necesita inicializarse antes de llamar a parse.
  await init;
  // parse devuelve posiciones de texto, útiles para reemplazos precisos.
  const [imports] = parse(source);
  // Solo modificamos imports que puedan apuntar a recursos web.
  const replacements = imports
    .filter(
      ({ n }) =>
        typeof n === "string" &&
        /^(?:[a-z][a-z\d+.-]*:|\/\/|\.{1,2}\/|\/)/i.test(n),
    )
    .map(({ s, e, n }) => {
      // Cada import se resuelve respecto al módulo que lo contiene.
      try {
        const importedUrl = new URL(n, destination);
        // Imports como data: o node: no deben pasar por este proxy HTTP.
        if (!["http:", "https:"].includes(importedUrl.protocol)) return null;
        return { start: s, end: e, value: makeProxyUrl(importedUrl) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    // Reemplazar desde el final evita desplazar las posiciones pendientes.
    .sort((left, right) => right.start - left.start);

  // Aplicamos cada sustitución sobre el código fuente original/modificado.
  for (const replacement of replacements) {
    source =
      source.slice(0, replacement.start) +
      replacement.value +
      source.slice(replacement.end);
  }
  // Devolvemos el módulo listo para cargar recursos a través del proxy.
  return source;
};

// Controlador común para las dos rutas públicas de proxy.
const proxyRequest = async (request, response) => {
  // destination se asigna después de validar la entrada del cliente.
  let destination;

  // Una URL mal formada se considera un error del cliente, no del upstream.
  try {
    destination = parseRequestUrl(request);
  } catch {
    return response.status(400).json({ error: "La URL no es válida." });
  }

  // El proxy solo sabe reenviar tráfico HTTP y HTTPS.
  if (!["http:", "https:"].includes(destination.protocol)) {
    return response
      .status(400)
      .json({ error: "Solo se permiten URLs HTTP y HTTPS." });
  }

  // Todo lo que pueda fallar al contactar o transformar el sitio remoto
  // se convierte en una respuesta controlada para no romper el proceso.
  try {
    // Copiamos cabeceras útiles, eliminando las gestionadas por este proxy.
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      const lowerName = name.toLowerCase();
      // Estas cabeceras pertenecen al salto actual o podrían filtrar contexto.
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
      // Express puede representar algunas cabeceras repetidas como arrays.
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (value) headers.set(name, value);
    }
    // El sitio remoto recibe un origen coherente con el destino solicitado.
    headers.set("Origin", destination.origin);
    // Referer ayuda a sitios que esperan navegación desde su propia página.
    headers.set("Referer", destination.href);

    // fetch realiza la petición de salida y sigue redirecciones del upstream.
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      // GET/HEAD/OPTIONS no llevan cuerpo; los demás conservan el recibido.
      body: ["GET", "HEAD", "OPTIONS"].includes(request.method)
        ? undefined
        : request.body,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    // El tipo determina si el cuerpo necesita reescritura o puede copiarse.
    const contentType = upstream.headers.get("content-type") || "";
    // HTML necesita adaptar recursos, enlaces y APIs ejecutadas en el navegador.
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml")
    ) {
      // Cargamos el documento para modificarlo como un árbol HTML.
      const document = cheerio.load(await upstream.text());
      // Estas políticas impedirían que el documento se muestre dentro del proxy.
      document(
        'meta[http-equiv="Content-Security-Policy"], meta[http-equiv="X-Frame-Options"]',
      ).remove();
      // Un <base> remoto original podría saltarse las URLs reescritas.
      document("base").remove();
      // Este base hace que las URLs relativas sigan resolviendo contra el sitio real.
      document("head").prepend(
        document("<base>").attr("href", destination.href),
      );

      // Este puente intercepta XHR y fetch creados por el JavaScript de la página.
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
        // Algunos botones abren el destino mediante window.open en vez de href.
        const originalOpenWindow = window.open;
        window.open = function(url, ...args) {
          return originalOpenWindow.call(this, url ? proxyUrl(url) : url, ...args);
        };
        // Convierte atributos que suelen usar los handlers de botones.
        const rewriteElementUrls = (element) => {
          for (const attribute of ['href', 'data-href', 'data-url']) {
            if (!element.hasAttribute(attribute)) continue;
            const value = element.getAttribute(attribute);
            element.setAttribute(attribute, proxyUrl(value));
          }
        };
        // También cubre botones y enlaces creados después de cargar el documento.
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const element of mutation.addedNodes) {
              if (element.nodeType !== Node.ELEMENT_NODE) continue;
              rewriteElementUrls(element);
              element.querySelectorAll('[href], [data-href], [data-url]')
                .forEach(rewriteElementUrls);
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // Poki puede crear o cambiar enlaces después de cargar el HTML.
        document.addEventListener('click', (event) => {
          const clickedElement = event.target instanceof Element
            ? event.target
            : event.target.parentElement;
          const link = clickedElement?.closest('[href], [data-href], [data-url]');
          if (!link || event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          rewriteElementUrls(link);
        }, true);
      })();`;
      document("head").prepend(document("<script>").text(bridge));

      // Recursos incrustados deben apuntar al proxy para evitar conexiones directas.
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

        // URL resuelve rutas relativas usando el destino como contexto.
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

      // Los enlaces navegables también permanecen dentro del proxy.
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

      // Conservamos el status HTTP, pero servimos el HTML ya transformado.
      response.status(upstream.status).type("html").send(document.html());
      return;
    }

    // Los módulos JS pueden contener imports que todavía apuntan al sitio real.
    if (
      contentType.includes("javascript") ||
      contentType.includes("ecmascript")
    ) {
      // Trabajamos como texto porque vamos a sustituir únicamente las rutas.
      const source = await upstream.text();
      const rewritten = await rewriteModuleImports(source, destination);
      response.status(upstream.status).type(contentType).send(rewritten);
      return;
    }

    // Para binarios y demás tipos copiamos el cuerpo byte a byte.
    const body = Buffer.from(await upstream.arrayBuffer());
    // Copiamos metadatos seguros y omitimos los que ya no describen este salto.
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
    // El status y el cuerpo originales se conservan para el cliente.
    response.status(upstream.status).send(body);
  } catch (error) {
    // TimeoutError se distingue para devolver 504 en vez de un 502 genérico.
    const timedOut = error.name === "TimeoutError";
    response.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "El sitio tardó demasiado en responder."
        : "No se pudo conectar con el sitio de destino.",
    });
  }
};

// Ruta corta para enviar la URL mediante query string.
app.all("/proxy", express.raw({ type: "*/*", limit: "25mb" }), proxyRequest);
// Ruta legible que incorpora protocolo, host, ruta y query en el path.
app.all(
  /^\/proxy\/(https?)\/([^/]+)(\/.*)?$/,
  express.raw({ type: "*/*", limit: "25mb" }),
  proxyRequest,
);

// Escuchamos en todas las interfaces para funcionar dentro de contenedores.
app.listen(port, "0.0.0.0", () => {
  // Este mensaje aparece en los logs de desarrollo y del proveedor de despliegue.
  console.log("Proxy HTTP activo en el puerto " + port);
});
