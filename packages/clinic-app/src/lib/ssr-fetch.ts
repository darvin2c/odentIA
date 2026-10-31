/**
 * Fetch hacia la API. En SSR la llamada sale a la dirección pública y vuelve por
 * Cloudflare: si ese tramo se corta (`TypeError: fetch failed`), toda la página
 * respondía 500. Una lectura sin efectos se repite una vez; lo que escribe nunca,
 * porque no se sabe si llegó. En el navegador no cambia nada.
 */
export const apiTransport: typeof fetch = async (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  if (typeof window !== "undefined" || method.toUpperCase() !== "GET") return fetch(input, init)
  try {
    return await fetch(input, init)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return fetch(input, init)
  }
}
