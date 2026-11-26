// Las guías de la web (lienzo UYxnET…, ADR 0216): cada guía es un archivo con su texto, y la web
// arma la página sola con el molde (`components/guides/GuidePage.astro`). El texto admite
// **negrita** y [enlaces](/ruta) (`rich.ts`). Ninguna cifra de precio de odentIA: el bloque final
// la lee de Precios. Antes de publicar una, la revisa la voz clínica y lo que dice de odentIA se
// cruza con el código.
import type { FaqItem } from "../faq"

/** Texto con **negrita** y [enlaces](/ruta). */
export type Rich = string

/** Las plantillas en PDF de `apps/web/public/guias/` (las escribe `pnpm --filter @odentia/services plantillas`). */
export type GuideSheet =
  | "odontograma"
  | "odontograma-ninos"
  | "presupuesto"
  | "historia-clinica"
  | "consentimiento"
  | "cierre-de-caja"
  | "plan-de-tratamiento"
  | "periodontograma"
  | "cie10-odontologia"

/** Un video del canal de YouTube de odentIA. */
export interface GuideVideo {
  youtubeId: string
  title: string
  /** Cuándo se publicó, con su hora y zona (ISO 8601, como lo da YouTube): Google lo pide para mostrar el video. */
  published: string
  /** Su primera línea en YouTube, para Google; sin ella, la descripción de la guía. */
  description?: string
}

/** La figura de un paso: la numeración, las caras o una tabla. */
export type GuideFigure =
  /** La numeración FDI como se mira de frente: una fila por cuadrante en el teléfono. */
  | { kind: "fdi"; dentition: "permanente" | "temporal" | "mixta"; mark?: number; caption: Rich }
  /** Las cinco caras de un diente de arriba (el 26), como en la hoja. */
  | { kind: "caras"; caption: Rich }
  /** `stack`: en el celular, cada fila en su bloque aunque tenga 3 columnas (lo hace solo con más de 3). */
  | { kind: "tabla"; head: string[]; rows: Rich[][]; caption?: Rich; stack?: boolean }

export interface GuideStep {
  title: string
  /** Los párrafos antes de la figura. */
  text: Rich[]
  /** Una lista, después de los párrafos. */
  list?: Rich[]
  figure?: GuideFigure
  /** Lo que va después de la figura. */
  after?: Rich[]
}

export interface Guide {
  /** La dirección: `/guias/<slug>`. */
  slug: string
  /** Su tema, en la ruta («Guías › Odontograma») y en las tarjetas. */
  topic:
    | "Odontograma"
    | "Periodontograma"
    | "Presupuestos"
    | "Plan de tratamiento"
    | "Historia clínica"
    | "CIE-10"
    | "Consentimiento"
    | "Caja"
  /** El título, en dos partes: la segunda va en color. */
  title: string
  accent: string
  /** El nombre corto: tarjetas, «Sigue con» y las migas para Google. */
  name: string
  /** El más corto, para el pie: «Odontograma en niños». */
  menu: string
  /** El título para Google y la descripción. */
  seoTitle: string
  description: string
  /** El párrafo de la portada. */
  lead: string
  /** Cuándo se revisó el texto por última vez (AAAA-MM-DD): la página, Google y el mapa del sitio. */
  updated: string
  /** Cuándo salió por primera vez: no cambia al editarla (Google la lee como la fecha del artículo). */
  published: string
  /**
   * La lista de reproducción del tema en el canal (PL…): la guía muestra sus videos, el más reciente
   * arriba y los demás en «Más videos de este tema». Un tutorial que se suma a la lista aparece solo.
   */
  playlist?: string
  /** El video fijo: el que se muestra sin lista o si YouTube no responde. Sin ninguno, no hay esa parte. */
  video?: GuideVideo
  /** «En corto»: la respuesta en tres líneas. */
  short: Rich[]
  steps: GuideStep[]
  /** Las plantillas de la guía, en el orden en que se ofrecen. */
  sheets: Array<{ sheet: GuideSheet; label: string; detail: string }>
  /** «Pruébalo aquí»: la demo de su página de producto y cómo se hace en odentIA. */
  tryIt: {
    demo:
      | "odontograma"
      | "odontograma-ninos"
      | "presupuesto"
      | "historia"
      | "consentimiento"
      | "caja"
      | "plan"
      | "periodontograma"
      | "cie10"
    title: string
    text: Rich
    /** Lo que se hace con la demo, si ella misma no lo dice. */
    note?: string
    product: { href: string; label: string }
  }
  faq: FaqItem[]
  /** Las guías de «Sigue con», por su slug. */
  related: string[]
  /** Lo que dice su tarjeta en el índice y en «Sigue con». */
  card: string
}
