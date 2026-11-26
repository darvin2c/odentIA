/**
 * «Mirar la tienda (solo mirar)» en la cuenta de una tienda de gestorIA (ADR 0219): va en el
 * pedido de entrar más nuevo de quien mira, que ya llegó a la app y que todavía puede estar por
 * aceptar o vigente. La administración no se entera de cuándo acepta la tienda: lo dice gestorIA
 * al abrirla.
 */

/** Lo que tarda en terminar un pedido de entrar: 24 horas para aceptarlo y hasta 1 hora adentro. */
export const SUPPORT_LOOK_MS = 25 * 3_600_000

export interface LookableRequest {
  id: string
  type: string
  status: string
  mine: boolean
  createdAt: string
}

/** El id del pedido donde va el botón, o null (los pedidos vienen del más nuevo al más viejo). */
export function lookableRequest(requests: LookableRequest[], now = Date.now()): string | null {
  const found = requests.find(
    (request) =>
      request.type === "soporte.entrar" &&
      request.mine &&
      request.status === "hecho" &&
      now - new Date(request.createdAt).getTime() < SUPPORT_LOOK_MS,
  )
  return found?.id ?? null
}
