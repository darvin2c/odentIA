// La app instalada de la clínica (ADR 0176). A propósito no tiene `fetch`: no guarda
// páginas ni datos en el equipo (lo que arma el servidor lleva datos de la clínica) y
// no puede dejar a nadie en una versión vieja. Solo muestra los avisos y, al tocarlos,
// abre la pantalla en la ventana que ya está abierta.

// Lo mismo que acepta un aviso de la campana (`checkNotice`): una ruta de esta clínica.
const INTERNAL = /^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // Sin datos legibles igual se muestra algo: el navegador lo exige en cada aviso.
  }
  const href = typeof data.href === "string" && INTERNAL.test(data.href) ? data.href : "/home"
  event.waitUntil(
    self.registration.showNotification(typeof data.title === "string" ? data.title : "Tu clínica", {
      body: typeof data.body === "string" ? data.body : "Tienes algo nuevo en Inicio",
      tag: typeof data.tag === "string" ? data.tag : "aviso",
      // El siguiente del mismo tipo reemplaza al anterior y vuelve a sonar.
      renotify: true,
      icon: typeof data.icon === "string" && INTERNAL.test(data.icon) ? data.icon : undefined,
      data: { href },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const href = event.notification.data && INTERNAL.test(event.notification.data.href) ? event.notification.data.href : "/home"
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open) {
        // La app navega con su router: así respeta lo que se está escribiendo.
        await open.focus()
        open.postMessage({ type: "odentia:abrir", href })
        return
      }
      await self.clients.openWindow(href)
    })(),
  )
})
