/**
 * Dev-only (WSL): Chromium resuelve *.localhost a loopback por sí mismo, pero
 * Node usa el DNS del SO y no conoce los hosts de portless. En SSR el fetch
 * corre en Node, así que mapeamos los hosts de portless a 127.0.0.1 vía undici.
 * Solo aplica en dev SSR; producción usa DNS real. Los imports dinámicos se
 * eliminan del bundle de cliente (import.meta.env.SSR === false ahí).
 */
if (import.meta.env.DEV && import.meta.env.SSR) {
  const dns = await import("node:dns")
  const { Agent, setGlobalDispatcher } = await import("undici")
  const localHosts = new Set(["odentia.localhost", "api.odentia.localhost"])
  setGlobalDispatcher(
    new Agent({
      connect: {
        lookup(hostname, options, callback) {
          if (localHosts.has(hostname)) {
            if (options.all) {
              callback(null, [{ address: "127.0.0.1", family: 4 }])
            } else {
              callback(null, "127.0.0.1", 4)
            }
            return
          }
        },
      },
    }),
  )
}

export {}
