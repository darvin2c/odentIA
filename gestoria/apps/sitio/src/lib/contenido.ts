// Los textos que comparten el Inicio y las páginas de la web (v5): las preguntas y los rubros.
// Solo dicen lo que gestorIA hace hoy; lo que viene va como «pronto» en la página que lo nombra.

export type Pregunta = readonly [pregunta: string, respuesta: string]

/** Las preguntas del Inicio: las que más hacen las tiendas antes de empezar. */
export const PREGUNTAS: readonly Pregunta[] = [
  [
    "¿Sofi puede bajar de mi precio mínimo?",
    "No. Tú pones el mínimo de cada producto y Sofi nunca vende por debajo. Ofrece una sola vez por conversación, a cambio de pagar en un plazo.",
  ],
  [
    "¿Sofi confirma los pagos?",
    "El link de pago se confirma solo. Una captura de Yape o de una transferencia la confirma una persona de tu equipo. Sin pago confirmado, el pedido no se entrega.",
  ],
  [
    "¿Sirve para mi rubro?",
    "Sí, si vendes productos con envío por chat. Cada producto tiene sus opciones (talla, color o tamaño), su stock y su precio mínimo.",
  ],
  [
    "¿Puedo probar a Sofi antes de vender?",
    "Sí. «Probar a Sofi» la pone a vender con tu catálogo, sin mover tu stock ni crear un link de pago real.",
  ],
  [
    "¿Puedo usar gestorIA desde el celular?",
    "Sí. No necesitas una computadora: desde el celular ves los pedidos, confirmas pagos y marcas las entregas.",
  ],
  [
    "¿Cuánto cuesta?",
    "USD 19 al mes, que vuelven a tu tienda como saldo. De ahí sale el 1 % de cada pedido que gestorIA genera sola. Lo que anota tu equipo no paga ese 1 %.",
  ],
]

/** Las que suma la página de preguntas. */
export const MAS_PREGUNTAS: readonly Pregunta[] = [
  [
    "¿Sofi inventa precios o stock?",
    "No. Sofi vende con tu catálogo y tu stock: si algo no está, no lo ofrece.",
  ],
  [
    "Si una clienta escribe por Instagram y por WhatsApp, ¿son dos clientas?",
    "Es una sola ficha cuando gestorIA sabe que es la misma persona. Si dos fichas parecen la misma clienta, te avisa y lo decides tú: nunca las une por el teléfono.",
  ],
  [
    "¿Quién usa gestorIA en mi tienda?",
    "Tu equipo, cada uno con su rol: Dueño, con todo y el plan; Administrador, todo menos el plan; y Ventas, que atiende, confirma pagos y entrega.",
  ],
  [
    "¿Quién entrega los pedidos?",
    "Tu equipo o tu repartidor, siempre con el pago confirmado. Si la clienta paga al recibir, quien entrega anota cuánto cobró y con qué. Pronto: gestorIA Reparto, la app del repartidor.",
  ],
  [
    "¿Puede pagar con Yape o tarjeta desde el chat?",
    "Hoy Sofi pide el pago con tus medios: Yape, Plin, transferencia o un link de pago. Pronto: «Pagar ahora», para pagar con Yape o tarjeta en un toque.",
  ],
]

/** Los rubros de ejemplo: gestorIA sirve a cualquier tienda que vende por chat. */
export const RUBROS: readonly string[] = [
  "Ropa",
  "Calzado",
  "Belleza",
  "Accesorios",
  "Joyería",
  "Tecnología",
  "Celulares",
  "Juguetes",
  "Regalos",
  "Mascotas",
  "Hogar",
  "Decoración",
  "Repostería",
  "Comida por encargo",
  "Plantas",
  "Libros",
  "Deportes",
  "Bebés",
  "Papelería",
  "Perfumes",
  "Lentes",
  "Artesanía",
  "Ropa de baño",
  "Lo que tú vendas",
]

/** Los datos de una página de preguntas para los buscadores (schema.org `FAQPage`). */
export function faqLd(preguntas: readonly Pregunta[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: preguntas.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  }
}
