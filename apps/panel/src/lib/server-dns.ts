/**
 * Dev-only: Chromium resuelve *.localhost a loopback por sí mismo, pero Node
 * usa el DNS del SO y no conoce los hosts de portless. En SSR el fetch corre
 * en Node, así que mapeamos a 127.0.0.1 el host de la API y el dominio base
 * (ambos vienen de env: dev usa odentia.localhost, el harness e2e usa
 * *.odentia.e2e.localhost). Producción usa DNS real. Los imports dinámicos se
 * eliminan del bundle de cliente (import.meta.env.SSR === false ahí).
 */
if (import.meta.env.DEV && import.meta.env.SSR) {
  const dns = await import("node:dns")
  const { Agent, setGlobalDispatcher } = await import("undici")
  const apiHost = new URL(import.meta.env.VITE_API_URL as string).hostname
  const baseDomain = (import.meta.env.VITE_BASE_DOMAIN as string | undefined) ?? ""
  const isLocalHost = (hostname: string) =>
    hostname === apiHost || hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)
  setGlobalDispatcher(
    new Agent({
      connect: {
        lookup(hostname, options, callback) {
          if (isLocalHost(hostname)) {
            if (options.all) {
              callback(null, [{ address: "127.0.0.1", family: 4 }])
            } else {
              callback(null, "127.0.0.1", 4)
            }
            return
          }
          dns.lookup(hostname, options, callback)
        },
      },
    }),
  )
}

export {}
