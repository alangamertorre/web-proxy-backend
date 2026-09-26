const form = document.querySelector("#address-form");
const input = document.querySelector("#url-input");
const frame = document.querySelector("#web-frame");
const emptyState = document.querySelector("#empty-state");
const currentAddress = document.querySelector("#current-address");
const hint = document.querySelector("#form-hint");

/* ---- HTML URL ---- */
// Detectar si viene una URL por los parámetros del navegador
const initialAddress = new URLSearchParams(window.location.search).get("url");
if (initialAddress) {
  try {
    const destination = new URL(initialAddress);
    if (["http:", "https:"].includes(destination.protocol)) {
      input.value = destination.href;
      cargarProxy(destination.href, destination.hostname);
    }
  } catch {
    hint.textContent =
      "La dirección recibida no es válida. Puedes introducir otra.";
    hint.classList.add("is-error");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const enteredAddress = input.value.trim();

  try {
    const destination = new URL(enteredAddress);
    if (!["http:", "https:"].includes(destination.protocol)) {
      throw new Error("Protocolo no válido");
    }
    cargarProxy(destination.href, destination.hostname);
  } catch {
    hint.textContent =
      "Introduce una dirección válida que empiece por http:// o https://";
    hint.classList.add("is-error");
  }
});

// FUNCIÓN CRÍTICA: Enruta la petición a través de tu backend en Railway
function cargarProxy(urlCompleta, hostname) {
  hint.textContent = "Cargando a través de Railway Proxy…";
  hint.classList.remove("is-error");
  currentAddress.textContent = hostname.toUpperCase();
  emptyState.setAttribute("hidden", "true"); // Corrección de accesibilidad para ocultar el estado vacío

  // CORRECCIÓN: Apunta a tu backend local, pasándole la URL como query param
  frame.src = `/proxy?url=${encodeURIComponent(urlCompleta)}`;
}

async function fetchWeb_Backend(src) {}
