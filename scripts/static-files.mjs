// Vite pone en /assets/ los archivos con su huella en el nombre (`index-Dtmj-IhO.js`):
// otro contenido es otro nombre, así que el navegador y Cloudflare los guardan un año
// sin volver a preguntar. Lo demás (chat.js, íconos) se sirve como hasta ahora.
// Sin imports: srvx es de cada app y desde aquí no se resuelve.
const HASHED = "/assets/"
const ONE_YEAR = "public, max-age=31536000, immutable"

/** Envuelve el `serveStatic` de srvx: los archivos con huella salen con la caché de un año. */
export function withHashedAssetCache(files) {
  return async (request, next) => {
    let fromFiles = true
    const response = await files(request, () => {
      fromFiles = false
      return next()
    })
    if (!fromFiles || response.status !== 200 || !new URL(request.url).pathname.startsWith(HASHED)) return response
    const headers = new Headers(response.headers)
    headers.set("Cache-Control", ONE_YEAR)
    return new Response(response.body, { status: response.status, headers })
  }
}
