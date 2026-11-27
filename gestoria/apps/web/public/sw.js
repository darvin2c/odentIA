// La app instalada de gestorIA (tablero 15), como la de las clínicas (ADR 0177). A propósito no
// tiene `fetch`: no guarda páginas ni datos en el celular (pedidos, clientas, montos) y no puede
// dejar a nadie en una versión vieja. Solo muestra los avisos y, al tocarlos, abre la pantalla
// que los resuelve en la ventana que ya está abierta.

// Una ruta de gestorIA, nunca otra dirección (`isInternalPath` de @odentia/ui-patterns).
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
  const href = typeof data.href === "string" && INTERNAL.test(data.href) ? data.href : "/"
  event.waitUntil(
    self.registration.showNotification(typeof data.title === "string" ? data.title : "gestorIA", {
      body: typeof data.body === "string" ? data.body : "Tienes algo nuevo en tu tienda",
      tag: typeof data.tag === "string" ? data.tag : "aviso",
      // El siguiente del mismo tipo reemplaza al anterior y vuelve a sonar: no se apilan.
      renotify: true,
      icon: typeof data.icon === "string" && INTERNAL.test(data.icon) ? data.icon : undefined,
      data: { href },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const href =
    event.notification.data && INTERNAL.test(event.notification.data.href)
      ? event.notification.data.href
      : "/"
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const ours = windows.filter((client) => new URL(client.url).origin === self.location.origin)
      ours.sort((a, b) => Number(b.focused) - Number(a.focused))
      for (const client of ours) {
        // La app navega con su router: así respeta lo que se está escribiendo.
        if (await handOver(client, href)) {
          await client.focus().catch(() => undefined)
          return
        }
      }
      await self.clients.openWindow(href)
    })(),
  )
})

/** Le pasa la pantalla a una ventana abierta de gestorIA; falso si no responde a tiempo. */
function handOver(client, href) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(false), 1500)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve(true)
    }
    client.postMessage({ type: "gestoria:abrir", href }, [channel.port2])
  })
}
