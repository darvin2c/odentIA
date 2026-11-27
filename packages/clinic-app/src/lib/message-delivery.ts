/**
 * Lo que pasó con el mensaje que llevó un papel (receta, consentimiento por firmar),
 * como lo dice el servidor (`messageDeliveryOf` de `budget-delivery.ts`): «Enviado»
 * mientras el canal no confirma, «Entregado» o «Leído» con su acuse y «No llegó» con
 * el motivo y qué hacer. La pantalla no lo deduce.
 */
export interface MessageDelivery {
  state: "enviado" | "entregado" | "leido" | "no_llego"
  channel: string
  at: string
  /** «Enviado por WhatsApp el 27 nov», «Entregado por WhatsApp · enviado el 27 nov», «No llegó por WhatsApp · enviado el 27 nov». */
  text: string
  /** Por qué no llegó; nulo si no falló. */
  reason: string | null
  /** Por qué no llegó y qué hacer, o que no se sabe si salió. */
  problem: string | null
}
