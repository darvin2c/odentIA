// Las guías de la web (lienzo UYxnET…, ADR 0214): cada guía es un archivo con su texto, y la web
// arma la página sola con el molde (`components/guides/GuidePage.astro`). El texto admite
// **negrita** y [enlaces](/ruta) (`rich.ts`). Ninguna cifra de precio de odentIA: el bloque final
// la lee de Precios. Antes de publicar una, la revisa la voz clínica y lo que dice de odentIA se
// cruza con el código.
import type { FaqItem } from "../faq"

/** Texto con **negrita** y [enlaces](/ruta). */
export type Rich = string

/** Las plantillas en PDF de `apps/web/public/guias/` (las escribe `pnpm --filter @odentia/services plantillas`). */
export type GuideSheet = "odontograma" | "odontograma-ninos" | "presupuesto"

/** La figura de un paso: la numeración, las caras o una tabla. */
export type GuideFigure =
  /** La numeración FDI como se mira de frente: una fila por cuadrante en el teléfono. */
  | { kind: "fdi"; dentition: "permanente" | "temporal" | "mixta"; mark?: number; caption: Rich }
  /** Las cinco caras de un diente de arriba (el 26), como en la hoja. */
  | { kind: "caras"; caption: Rich }
  | { kind: "tabla"; head: string[]; rows: Rich[][]; caption?: Rich }

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
  topic: "Odontograma" | "Presupuestos"
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
  /** El video de YouTube, cuando esté publicado; sin él, la guía no muestra esa parte. */
  video?: { youtubeId: string; title: string }
  /** «En corto»: la respuesta en tres líneas. */
  short: Rich[]
  steps: GuideStep[]
  /** Las plantillas de la guía, en el orden en que se ofrecen. */
  sheets: Array<{ sheet: GuideSheet; label: string; detail: string }>
  /** «Pruébalo aquí»: la demo de su página de producto y cómo se hace en odentIA. */
  tryIt: {
    demo: "odontograma" | "odontograma-ninos" | "presupuesto"
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
