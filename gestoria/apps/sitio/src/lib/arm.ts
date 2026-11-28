// El ARM en la web (web v5): qué es y en qué se diferencia de un CRM y de un chatbot. Se compara con
// la categoría, nunca con una marca. Lo que el ARM hace tiene que ser cierto en gestorIA hoy: Sofi
// atiende, negocia sin bajar del mínimo (una oferta, con plazo) y cobra con el link; el stock baja
// solo al confirmarse el pago y la compra queda sola en la ficha de la clienta (gestorIA); empacar
// y entregar lo hace el equipo, y una captura de Yape la confirma una persona. Ningún texto dice
// que un aviso a la clienta se envió.
import type { Pregunta } from "./contenido"

/** Una fila del duelo: el paso, cómo se hace con el otro y cómo con el ARM. `tuyo`: lo hace tu equipo. */
export type FilaDuelo = { paso: string; otro: string; arm: string; quien: string; tuyo?: boolean }

export const DUELO_CRM: FilaDuelo[] = [
  {
    paso: "Responder",
    otro: "Tú, cuando veas el mensaje",
    arm: "Al instante, aunque sean las 21:14",
    quien: "Sofi",
  },
  {
    paso: "Ver talla y stock",
    otro: "Tú, revisando tu stock",
    arm: "En tu catálogo y tu stock",
    quien: "Sofi",
  },
  {
    paso: "Negociar el precio",
    otro: "Tú, cuidando no regalar",
    arm: "Una oferta, sin bajar de tu mínimo",
    quien: "Sofi",
  },
  {
    paso: "Pedir el pago",
    otro: "Tú, mandando tu Yape",
    arm: "Con el link de pago, que se confirma solo",
    quien: "Sofi",
  },
  {
    paso: "Anotar el pedido",
    otro: "Tú, a mano en el CRM",
    arm: "Con su envío y su total",
    quien: "Sofi",
  },
  {
    paso: "Descontar el stock",
    otro: "Tú, si te acuerdas",
    arm: "Solo, al confirmarse el pago",
    quien: "gestorIA",
  },
  {
    paso: "Empacar y entregar",
    otro: "Tú",
    arm: "Con el pago confirmado",
    quien: "Tu equipo",
    tuyo: true,
  },
  {
    paso: "Guardar la compra",
    otro: "Tú, en la ficha de la clienta",
    arm: "Sola, en la ficha de la clienta",
    quien: "gestorIA",
  },
]

/**
 * Una burbuja de los dos teléfonos. `turno` los sincroniza: el mismo turno llega a la vez a ambos.
 * `nota` dice qué hizo quien responde; `tarjeta`, lo que va pegado al mensaje (el producto o el pago).
 */
export type Msg = {
  turno: number
  de: "ella" | "otro" | "sofi"
  hora: string
  texto: string
  nota?: string
  tarjeta?: { titulo: string; detalle: string; cifra: string; boton?: string }
}

export const CHAT_CLIENTA: Msg[] = [
  { turno: 0, de: "ella", hora: "21:14", texto: "Hola, ¿tienes la zapatilla blanca en talla 38?" },
  { turno: 1, de: "ella", hora: "21:15", texto: "¿Me la dejas en 110?" },
  { turno: 2, de: "ella", hora: "21:16", texto: "Ya, sepáramela. Es para Surco" },
]
export const CHAT_BOT: Msg[] = [
  {
    turno: 0,
    de: "otro",
    hora: "21:14",
    texto:
      "¡Hola! Gracias por escribir a Calzados Rosa. Elige una opción: 1. Catálogo 2. Horarios 3. Asesor",
    nota: "Menú fijo: no mira tu stock",
  },
  {
    turno: 1,
    de: "otro",
    hora: "21:15",
    texto: "No entendí tu mensaje. Responde 1, 2 o 3.",
    nota: "No entiende precios",
  },
  {
    turno: 2,
    de: "otro",
    hora: "21:16",
    texto: "Te derivamos con un asesor. Atendemos de lunes a viernes, de 9 a 6.",
    nota: "Te pasa el chat a ti",
  },
]
export const CHAT_SOFI: Msg[] = [
  {
    turno: 0,
    de: "sofi",
    hora: "21:14",
    texto: "¡Hola, Andrea! Sí, en talla 38 me quedan 2 pares. Es de cuero y la horma es cómoda.",
    nota: "Miró tu catálogo y tu stock",
    tarjeta: { titulo: "Zapatilla Urbana Blanca", detalle: "Talla 38 · quedan 2", cifra: "S/ 139" },
  },
  {
    turno: 1,
    de: "sofi",
    hora: "21:15",
    texto:
      "A 110 no llego. Si la pagas hoy antes de las 23:00, te la dejo en S/ 129. ¿Te la separo?",
    nota: "Una oferta, con plazo, sobre tu mínimo",
  },
  {
    turno: 2,
    de: "sofi",
    hora: "21:16",
    texto: "¡Listo! Con el envío a Surco son S/ 139. Aquí tienes tu link de pago:",
    nota: "Sumó el envío y armó el cobro",
    tarjeta: {
      titulo: "Pedido 1042",
      detalle: "Zapatilla 38 + envío a Surco",
      cifra: "S/ 139",
      boton: "Pagar",
    },
  },
]

/** Lo que pasa después del chat: con el ARM se hace solo; con el chatbot, queda para ti. */
export const DESPUES_SOFI: [string, string][] = [
  ["21:18", "Pago confirmado con el link"],
  ["21:18", "Pedido 1042 anotado, con su envío"],
  ["21:18", "Stock de la talla 38: de 2 a 1"],
  ["21:18", "En Despachos, listo para salir"],
  ["21:18", "Compra guardada en la ficha de Andrea"],
]
export const DESPUES_BOT: string[] = [
  "Responder a Andrea mañana a las 9",
  "Ver si queda la talla 38",
  "Negociar y mandar tu Yape",
  "Anotar el pedido y bajar el stock",
]

/**
 * El ciclo completo de una venta por chat, de la primera pregunta a la clienta que vuelve: por qué
 * gestorIA es un ARM. Cada paso dice quién lo hace hoy y a qué página lleva; lo que aún no existe va
 * como `pronto`. `crm` y `chatbot` dicen si esa herramienta lo cubre (para las barras de cobertura).
 */
export type Paso = {
  verbo: string
  quien: string
  texto: string
  href: string
  enlace: string
  pronto?: string
  crm?: boolean
  chatbot?: boolean
}

export const CICLO: Paso[] = [
  {
    verbo: "Atiende",
    quien: "Sofi",
    texto:
      "Contesta tu WhatsApp, Instagram y Messenger a la hora que sea, con una sola ficha por clienta.",
    href: "/sofi",
    enlace: "Conoce a Sofi",
    chatbot: true,
  },
  {
    verbo: "Vende",
    quien: "Sofi",
    texto: "Entiende qué busca, mira tu catálogo y tu stock por talla y color, y muestra el valor.",
    href: "/catalogo",
    enlace: "Ver Catálogo",
  },
  {
    verbo: "Negocia",
    quien: "Sofi",
    texto:
      "Una sola oferta por conversación, con plazo para pagar y nunca por debajo de tu mínimo.",
    href: "/sofi",
    enlace: "Cómo negocia",
  },
  {
    verbo: "Cobra",
    quien: "Sofi",
    texto:
      "Pide el pago con tus medios. El link se confirma solo; una captura de Yape la confirma una persona.",
    href: "/cobros",
    enlace: "Ver Cobros",
  },
  {
    verbo: "Ordena el stock",
    quien: "gestorIA",
    texto:
      "El stock de cada variante baja solo al confirmarse el pago y vuelve si el pedido se anula.",
    href: "/inventario",
    enlace: "Ver Inventario",
  },
  {
    verbo: "Despacha",
    quien: "Tu equipo",
    texto:
      "Lo que sale hoy, en Despachos, con su franja y su repartidor. Sin pago confirmado, no sale.",
    href: "/entregas",
    enlace: "Ver Entregas",
  },
  {
    verbo: "Reparte",
    quien: "Tu repartidor",
    texto: "Si pagan al recibir, anota lo que cobró y con qué; queda a su nombre y Caja lo recibe.",
    href: "/entregas",
    enlace: "Ver Entregas",
    pronto: "gestorIA Reparto, la app del repartidor",
  },
  {
    verbo: "Recuerda",
    quien: "Argos",
    texto:
      "Cada compra queda en la ficha de la clienta; Argos te dice lo que te toca hoy y cómo vas.",
    href: "/argos",
    enlace: "Conoce a Argos",
    crm: true,
  },
]

/** Una fila de la tabla: qué se compara, cómo es en el otro y cómo en el ARM. */
export type FilaComp = [string, string, string]

export const TABLA_CRM: FilaComp[] = [
  ["Quién trabaja", "Tú y tu equipo; el CRM guarda", "Los agentes; tu equipo decide"],
  ["Responder a las clientas", "A mano, en horario", "Sofi, a toda hora"],
  ["Vender y negociar", "A mano", "Sofi, sin bajar de tu mínimo"],
  ["Cobrar", "Mandas tus datos y revisas", "Link de pago que se confirma solo"],
  ["Pedidos y stock", "Se anotan a mano", "Se anotan y se descuentan solos"],
  ["La ficha de la clienta", "La llenas tú", "Se llena con cada chat y cada compra"],
  ["Lo que te queda a ti", "Todo", "Empacar, entregar y decidir"],
  [
    "Cuánto pagas",
    "Por usuario o por plan",
    "USD 19 al mes que vuelven como saldo y el 1 % de lo que vendes",
  ],
]

export const TABLA_CHATBOT: FilaComp[] = [
  ["Cómo conversa", "Menús y respuestas fijas", "Como una vendedora: entiende y pregunta"],
  [
    "Si le preguntan otra cosa",
    "«No entendí», o pasa a un asesor",
    "Responde con tu catálogo y tu stock",
  ],
  ["Negociar", "No negocia", "Una oferta, sin bajar de tu mínimo"],
  ["Cobrar", "No cobra", "Pide el pago con el link"],
  ["Pedidos y stock", "No los toca", "Anota el pedido y descuenta el stock"],
  ["Después de la venta", "Se acaba la conversación", "La compra queda en la ficha de la clienta"],
  ["Lo que te queda a ti", "Retomar cada chat que se trabó", "Empacar, entregar y decidir"],
]

export const PREGUNTAS_ARM: Pregunta[] = [
  [
    "¿Qué es un ARM?",
    "ARM quiere decir Agentic Relationship Management: la relación con tus clientas la llevan agentes de IA que trabajan dentro de tus reglas. En gestorIA, Sofi vende y cobra por chat y Argos cuida tu stock y a tus clientas. Tú decides lo que pide una persona.",
  ],
  [
    "¿En qué se diferencia de un CRM?",
    "Un CRM guarda lo que tu equipo anota. Un ARM hace el trabajo: responde, vende, cobra, anota el pedido y descuenta el stock. A tu equipo le quedan empacar, entregar y decidir.",
  ],
  [
    "¿Y de un chatbot?",
    "Un chatbot contesta preguntas. Un ARM vende de punta a punta: negocia sin bajar de tu mínimo, cobra, anota el pedido y recuerda a cada clienta para la próxima.",
  ],
  [
    "¿Los agentes deciden solos?",
    "Trabajan dentro de las reglas que pones: tu precio mínimo y tus medios de pago. Lo que pide una persona, como confirmar una captura de Yape, siempre pasa por una persona.",
  ],
]

export const PREGUNTAS_CRM: Pregunta[] = [
  [
    "¿gestorIA es un CRM?",
    "No. Tiene lo que da un CRM, como la ficha de cada clienta con sus chats y sus compras, pero el trabajo lo hacen los agentes. Por eso es un ARM.",
  ],
  [
    "¿Cuándo me basta un CRM?",
    "Si vendes en persona y solo necesitas ordenar tus contactos, un CRM puede bastarte. Si vendes por WhatsApp, Instagram o Messenger, un ARM atiende, vende y cobra por ti.",
  ],
  [
    "¿Mi equipo sigue teniendo el control?",
    "Sí. Cada persona entra con su rol (Dueño, Administrador o Ventas), ve lo que hicieron los agentes y decide lo que pide una persona.",
  ],
  [
    "¿Cuánto cuesta frente a un CRM?",
    "Un solo plan: USD 19 al mes que vuelven como saldo, y de ahí el 1 % de lo que vendes. No hay cobro por persona del equipo.",
  ],
]

export const PREGUNTAS_CHATBOT: Pregunta[] = [
  [
    "¿Sofi es un chatbot?",
    "No. Un chatbot contesta. Sofi vende: entiende lo que busca la clienta, mira tu catálogo y tu stock, negocia sin bajar de tu mínimo, cobra y anota el pedido.",
  ],
  [
    "¿Y si mi chatbot ya usa IA?",
    "Contestará mejor, pero contestar no es vender. Pregúntate si también cobra, anota el pedido, descuenta el stock y recuerda a la clienta. Eso es lo que hace un ARM.",
  ],
  [
    "¿En qué chats funciona Sofi?",
    "En WhatsApp, Instagram y Messenger, con una sola ficha por clienta, escriba por donde escriba.",
  ],
  [
    "¿Sofi puede regalar mi producto?",
    "No. Tú pones el mínimo de cada producto y Sofi nunca vende por debajo. Ofrece una sola vez por conversación.",
  ],
]
