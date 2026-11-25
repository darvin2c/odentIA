// Términos y Privacidad de gestorIA: su forma completa (índice y secciones) con lo que falta marcado
// «[Por completar…]» o «[Por confirmar…]» (lienzo B8, decisión 6). Solo dice lo que ya es cierto:
// los datos de la empresa son los de odentia32.com/privacidad y lo demás, lo que gestorIA ya hace.
// Mientras un documento tenga marcas, va con noindex y fuera del mapa del sitio.
import { CONTACT_EMAIL } from "./sitio"

/** Un bloque de una sección: un párrafo o una lista. */
export type LegalBlock = string | { list: string[] }

export type LegalSection = { id: string; title: string; blocks: LegalBlock[] }

export type LegalDoc = {
  path: "/terminos" | "/privacidad"
  title: string
  description: string
  intro: string
  /** Desde cuándo rige; mientras no se publique el texto, un marcador. */
  since: string
  sections: LegalSection[]
}

/** El titular de gestorIA, como figura en odentia32.com/privacidad. */
export const TITULAR = {
  razonSocial: "SALLCA GROUP E.I.R.L.",
  ruc: "20603338741",
  domicilio: "Av. General Andrés de Santa Cruz 176, Urb. Fundo Oyague, Jesús María, Lima, Perú",
} as const

const RESPONSABLE = `gestorIA es una marca del Grupo Sallca. El responsable es ${TITULAR.razonSocial}, con RUC ${TITULAR.ruc} y domicilio en ${TITULAR.domicilio}.`

const MARCA = /\[Por (completar|confirmar)/

/** Verdadero si el documento conserva algún «[Por completar…]» o «[Por confirmar…]». */
export function hasPending(doc: LegalDoc): boolean {
  return MARCA.test(JSON.stringify(doc))
}

export type Segment = { text: string; mark?: true; href?: string }

/**
 * Parte un texto en trozos: el texto normal, los marcadores de lo que falta (para resaltarlos) y los
 * enlaces escritos «[texto](dirección)».
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  const pattern = /\[(Por (?:completar|confirmar)[^\]]*)\]|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    if (match[1]) out.push({ text: `[${match[1]}]`, mark: true })
    else out.push({ text: match[2] ?? "", href: match[3] ?? "" })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export const PRIVACIDAD: LegalDoc = {
  path: "/privacidad",
  title: "Política de privacidad",
  description: "Cómo cuida gestorIA los datos de quien vende con la app y los de sus clientes.",
  intro: "Cómo gestorIA cuida los datos de quien vende con la app y los de sus clientes.",
  since: "[Por completar: fecha]",
  sections: [
    { id: "responsable", title: "Quién es el responsable", blocks: [RESPONSABLE] },
    {
      id: "datos",
      title: "Qué datos usamos",
      blocks: [
        "Los de tu cuenta (nombre, correo y foto), los de tu tienda y lo que pasa en ella: catálogo, pedidos, pagos y conversaciones.",
        "[Por completar]",
      ],
    },
    { id: "para-que", title: "Para qué los usamos", blocks: ["[Por completar]"] },
    {
      id: "clientes",
      title: "Los datos de los clientes de tu tienda",
      blocks: [
        "Los datos de quien te compra son de tu tienda. gestorIA los usa solo para atender, vender y entregar por ti.",
        "[Por completar]",
      ],
    },
    {
      id: "proveedores",
      title: "Con quién trabajamos",
      blocks: [
        "Los servicios que hacen funcionar gestorIA: los chats de Meta, el modelo de lenguaje de Sofi, el link de pago que conecta tu tienda y el alojamiento.",
        "[Por confirmar: lista de proveedores]",
      ],
    },
    { id: "plazos", title: "Cuánto tiempo los guardamos", blocks: ["[Por completar]"] },
    {
      id: "derechos",
      title: "Tus derechos y cómo pedirlos",
      blocks: [`Escríbenos a [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL}).`, "[Por completar]"],
    },
  ],
}

export const TERMINOS: LegalDoc = {
  path: "/terminos",
  title: "Términos de uso",
  description: "Las condiciones para usar gestorIA y vender con Sofi y Argos.",
  intro: "Las condiciones para usar gestorIA en tu tienda.",
  since: "[Por completar: fecha]",
  sections: [
    { id: "quien", title: "Quién ofrece gestorIA", blocks: [RESPONSABLE] },
    {
      id: "servicio",
      title: "Qué es gestorIA",
      blocks: [
        "Una app para vender por WhatsApp, Instagram y Messenger. Sofi atiende a tus clientes con tu catálogo y tu stock, y Argos te muestra tus números y lo que toca hoy.",
        "[Por completar]",
      ],
    },
    {
      id: "cuenta",
      title: "Tu cuenta, tu tienda y tu equipo",
      blocks: [
        "Entras con la misma cuenta de las apps del Grupo Sallca. Cada tienda tiene su equipo, con los roles Dueño, Administrador y Ventas.",
        "[Por completar]",
      ],
    },
    {
      id: "decides",
      title: "Lo que hace Sofi y lo que decides tú",
      blocks: [
        {
          list: [
            "Sofi nunca vende por debajo del precio mínimo que pones a cada producto.",
            "Sofi nunca da por confirmado un pago con captura: lo confirma una persona de tu equipo.",
            "Puedes pausar a Sofi cuando quieras y la conversación pasa a una persona.",
          ],
        },
        "[Por completar]",
      ],
    },
    { id: "planes", title: "Planes y pagos", blocks: ["[Por completar]"] },
    { id: "uso", title: "Uso aceptable", blocks: ["[Por completar]"] },
    { id: "responsabilidad", title: "Responsabilidad", blocks: ["[Por completar]"] },
    { id: "cambios", title: "Cambios y ley aplicable", blocks: ["[Por completar]"] },
  ],
}
