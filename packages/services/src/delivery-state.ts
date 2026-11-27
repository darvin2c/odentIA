/**
 * Qué pasó con un mensaje después de dejarlo en la cola, según su `status`. Lo
 * comparten los casos de Sofi («enviado» en el trabajo solo significa que salió
 * hacia el canal) y la entrega de un presupuesto (`budget-delivery.ts`):
 * `enviando` mientras el proveedor no lo acepta, `aceptado` cuando lo aceptó,
 * `entregado` o `leido` cuando el proveedor lo confirma, y `no_entregado` si lo
 * rechazó.
 */
export type JobDelivery = "enviando" | "aceptado" | "entregado" | "leido" | "no_entregado"

export function deliveryOf(messageStatus: string | null | undefined): JobDelivery | null {
  if (!messageStatus) return null
  if (messageStatus === "queued" || messageStatus === "unknown") return "enviando"
  if (messageStatus === "sent") return "aceptado"
  if (messageStatus === "delivered") return "entregado"
  if (messageStatus === "read") return "leido"
  if (messageStatus === "failed") return "no_entregado"
  return null
}
