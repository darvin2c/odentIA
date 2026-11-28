// La venta de ejemplo que cuenta el Inicio (web v4): la conversación de la semilla de Calzados Rosa
// (Valeria Soto), como la ve la clienta en WhatsApp. Lo que «hizo» Sofi son los rótulos que la app
// muestra bajo cada respuesta en «Probar a Sofi». Sin teléfonos ni números de casa.

export type Mensaje = { de: "clienta" | "sofi"; texto: string; hora: string; hizo?: string }

export const MENSAJES: readonly Mensaje[] = [
  { de: "clienta", texto: "Hola, ¿tienen la zapatilla blanca en 38?", hora: "9:41" },
  {
    de: "sofi",
    texto:
      "¡Hola! Soy Sofi, de Calzados Rosa. Sí, la Zapatilla urbana blanca en 38 cuesta S/ 129. Es de cuero sintético con planta de goma y horma normal: pide tu talla de siempre. ¿Te la envío o la recoges?",
    hora: "9:41",
    hizo: "Buscó en el catálogo",
  },
  { de: "clienta", texto: "¿Me la dejas en 110? Es para Surco", hora: "9:42" },
  {
    de: "sofi",
    texto:
      "A 110 no llego, pero te regalo el envío a Surco (S/ 10) y te la dejo en S/ 120, todo incluido, si lo pagas hasta mañana a las 10:58 a. m. ¿Te la anoto?",
    hora: "9:42",
    hizo: "Calculó el total sin bajar del mínimo",
  },
  { de: "clienta", texto: "Ya, va. Es para Av. Primavera, Surco. Soy Valeria Soto", hora: "9:43" },
  {
    de: "sofi",
    texto:
      "Listo, Valeria: pedido 0018, 1 Zapatilla urbana blanca talla 38 con reparto a Surco gratis. Total S/ 120. Puedes pagar por Yape y me mandas la captura.",
    hora: "9:43",
    hizo: "Anotó el pedido 0018",
  },
  { de: "clienta", texto: "Listo, te yapeé 120", hora: "9:45" },
  {
    de: "sofi",
    texto:
      "¡Gracias, Valeria! Anoté tu pago de S/ 120: una persona del equipo lo revisa y te aviso apenas esté confirmado.",
    hora: "9:45",
    hizo: "Anotó la captura: pago por confirmar",
  },
]

/**
 * Lo que sigue en la venta del Inicio (web v5), en la escena «de punta a punta»: el aviso de Sofi
 * cuando el equipo confirma el pago y la oferta de sumar algo antes de que el pedido salga.
 */
export const DESPUES: readonly Mensaje[] = [
  {
    de: "sofi",
    texto: "¡Listo, Valeria! Tu pago de S/ 120 está confirmado. Tu pedido sale hoy a Surco.",
    hora: "9:52",
    hizo: "Avisó a la clienta",
  },
  {
    de: "sofi",
    texto: "Antes de que salga: ¿te sumo unas medias blancas por S/ 15? Van en el mismo envío.",
    hora: "9:52",
    hizo: "Ofreció sumar algo",
  },
  { de: "clienta", texto: "¡Sí, súmalas!", hora: "9:53" },
]

/** Una pregunta del chat que se puede tocar en el héroe (web v5) y la respuesta de muestra de Sofi. */
export type PreguntaChat = { q: string; a: string; humor: "atenta" | "decidida" | "feliz" }

/** Respuestas de muestra de Calzados Rosa: la web dice que son un ejemplo. */
export const CHAT_VIVO: readonly PreguntaChat[] = [
  {
    q: "¿Tienes la zapatilla blanca en talla 38?",
    a: MENSAJES[1]?.texto.replace(/^¡Hola! Soy Sofi, de Calzados Rosa\. /, "") ?? "",
    humor: "atenta",
  },
  { q: "¿Me la dejas en 110?", a: MENSAJES[3]?.texto ?? "", humor: "decidida" },
  {
    q: "¿Cómo pago?",
    a: "Por Yape, Plin o transferencia. Me mandas la captura y una persona del equipo la confirma. Con el pago confirmado, tu pedido sale.",
    humor: "atenta",
  },
  {
    q: "¡Ya, va!",
    a: "¡Listo! Te anoté el pedido 0018: Zapatilla urbana blanca 38, reparto a Surco gratis. Total S/ 120. Puedes pagar por Yape y me mandas la captura.",
    humor: "feliz",
  },
]

/** El saludo con que abre el chat del héroe. */
export const SALUDO = "¡Hola! Soy Sofi, de Calzados Rosa. ¿Qué estás buscando?"
