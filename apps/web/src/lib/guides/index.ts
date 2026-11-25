// Las guías de la web (ADR 0215): la lista, sus direcciones y lo que se arma de cada archivo (los
// minutos de lectura, la fecha en palabras y los datos para Google). Hoy son solo de odentIA: en
// latidIA y vistIA, /guias no existe (`product-pages.json` no la sirve) y el pie no las muestra.
import { PRODUCT } from "../product"
import { guide as odontograma } from "./como-llenar-un-odontograma"
import { guide as ninos } from "./odontograma-en-ninos"
import { guide as presupuesto } from "./presupuesto-dental"
import { plainText } from "./rich"
import type { Guide, GuideSheet } from "./types"

export type { Guide, GuideFigure, GuideSheet, GuideStep, Rich } from "./types"

/** Las guías, en el orden del índice. Una nueva se suma aquí y con su página en `src/pages/guias/`. */
export const GUIDES: readonly Guide[] = [odontograma, ninos, presupuesto]

/** ¿Esta web tiene guías? Solo la de odentIA, hasta que las otras tengan las suyas. */
export const HAS_GUIDES = PRODUCT === "dental"

export const GUIDES_PATH = "/guias"
export const guidePath = (guide: Guide): string => `${GUIDES_PATH}/${guide.slug}`

export function guideBySlug(slug: string): Guide {
  const found = GUIDES.find((guide) => guide.slug === slug)
  if (!found) throw new Error(`No existe la guía ${slug}`)
  return found
}

/** Las de «Sigue con», en el orden que dice la guía. */
export function relatedOf(guide: Guide): Guide[] {
  return guide.related.map(guideBySlug)
}

/** Dónde se descarga cada plantilla (los archivos que escribe `pnpm --filter @odentia/services plantillas`). */
export const SHEET_FILES: Record<GuideSheet, string> = {
  odontograma: "/guias/odontograma.pdf",
  "odontograma-ninos": "/guias/odontograma-ninos.pdf",
  presupuesto: "/guias/presupuesto-dental.pdf",
}

/** Todo el texto de la guía, sin marcas. */
function textOf(guide: Guide): string {
  return [
    guide.lead,
    ...guide.short,
    ...guide.steps.flatMap((step) => [
      step.title,
      ...step.text,
      ...(step.list ?? []),
      ...(step.after ?? []),
      ...(step.figure?.kind === "tabla" ? step.figure.rows.flat() : []),
      step.figure?.caption ?? "",
    ]),
    ...guide.faq.flatMap((item) => [item.q, item.a]),
  ]
    .map(plainText)
    .join(" ")
}

/** Los minutos de lectura, a 200 palabras por minuto: se cuentan del texto, no se escriben a mano. */
export function readingMinutes(guide: Guide): number {
  const words = textOf(guide).split(/\s+/).filter(Boolean).length
  return Math.max(2, Math.ceil(words / 200))
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"]

/** «24 nov 2026», de la fecha del archivo (AAAA-MM-DD). */
export function dayWords(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number)
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`
}

/** Lo que trae la guía, en su tarjeta: «6 min · 2 plantillas en PDF · Video». */
export function cardMeta(guide: Guide): string {
  const sheets = guide.sheets.length === 1 ? "Plantilla en PDF" : `${guide.sheets.length} plantillas en PDF`
  return [`${readingMinutes(guide)} min`, sheets, guide.video ? "Video" : null].filter(Boolean).join(" · ")
}

/**
 * Los datos para Google de una guía: el artículo con su fecha y las migas. Las preguntas van
 * aparte (`faqJsonLd`), como en las demás páginas.
 */
export function guideArticleJsonLd(site: URL | undefined, guide: Guide, publisher: string) {
  const url = new URL(guidePath(guide), site).toString()
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: plainText(`${guide.title} ${guide.accent}`).replace(/[,.]\s*$/, ""),
    description: guide.description,
    datePublished: guide.updated,
    dateModified: guide.updated,
    inLanguage: "es",
    mainEntityOfPage: url,
    url,
    author: { "@id": publisher },
    publisher: { "@id": publisher },
  }
}
