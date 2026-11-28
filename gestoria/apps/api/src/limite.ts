/**
 * Un tope de pedidos por clave en una ventana de tiempo, en la memoria del proceso: lo usan las
 * rutas que cualquiera puede llamar (los avisos del link de pago, la vitrina pública). Con dos
 * servidores, cada uno cuenta lo suyo; alcanza para frenar a quien pide sin parar. Si se llena de
 * claves, empieza de cero en vez de crecer.
 */
export interface RateLimit {
  /** Cuenta un pedido de esa clave: `true` si todavía entra en el tope. */
  hit(key: string, now?: number): boolean
}

export function createRateLimit(options: {
  max: number
  windowMs: number
  maxKeys?: number
}): RateLimit {
  const seen = new Map<string, { since: number; count: number }>()
  const maxKeys = options.maxKeys ?? 10_000
  return {
    hit(key, now = Date.now()) {
      const entry = seen.get(key)
      if (!entry || now - entry.since > options.windowMs) {
        if (!entry && seen.size >= maxKeys) seen.clear()
        seen.set(key, { since: now, count: 1 })
        return true
      }
      entry.count++
      return entry.count <= options.max
    },
  }
}

/**
 * Quién pide, para el tope: la IP que pone Cloudflare (la API solo se publica por su túnel), o la
 * primera de `x-forwarded-for`; sin ninguna, el pedido cuenta como de un mismo lugar.
 */
export function clientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local"
  )
}
