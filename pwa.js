const INSTALL_EVENT_KEY = "__imageEditorInstallPrompt";

export function initPwaSupport() {
  captureInstallPrompt();
  registerServiceWorker();
}

function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    window[INSTALL_EVENT_KEY] = event;
    
    // Automatically show our Install button if one exists on the current page
    const installBtn = document.getElementById("installAppBtn");
    if (installBtn) {
      installBtn.style.display = "block";
      installBtn.onclick = async () => {
        installBtn.style.display = "none";
        event.prompt();
        const { outcome } = await event.userChoice;
        console.log(`User response to install prompt: ${outcome}`);
        window[INSTALL_EVENT_KEY] = null;
      };
    }
  });

  window.addEventListener("appinstalled", () => {
    window[INSTALL_EVENT_KEY] = null;
    const installBtn = document.getElementById("installAppBtn");
    if (installBtn) installBtn.style.display = "none";
    console.log("PWA installed successfully!");
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!import.meta.env.PROD) return;

  // 1) Mandate strict HTTPS deployment across the entire application
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
    console.warn("PWA requires strict HTTPS deployment. Service Worker registration blocked for security.");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;

      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          console.info("A newer offline shell is ready. Reload to update.");
        }
      });
    });
  } catch (error) {
    console.warn("Service worker registration failed:", error);
  }
}

export function getDeferredInstallPrompt() {
  return window[INSTALL_EVENT_KEY] || null;
}
