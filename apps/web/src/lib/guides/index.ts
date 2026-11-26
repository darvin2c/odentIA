// Las guías de la web (ADR 0216): la lista, sus direcciones y lo que se arma de cada archivo (los
// minutos de lectura, la fecha en palabras y los datos para Google). Hoy son solo de odentIA: en
// latidIA y vistIA, /guias no existe (`product-pages.json` no la sirve) y el pie no las muestra.
import { PRODUCT } from "../product"
import { guide as cie10 } from "./cie-10-odontologia"
import { guide as caja } from "./cierre-de-caja-dental"
import { guide as odontograma } from "./como-llenar-un-odontograma"
import { guide as periodontograma } from "./como-llenar-un-periodontograma"
import { guide as consentimiento } from "./consentimiento-informado-dental"
import { guide as historia } from "./historia-clinica-odontologica"
import { guide as ninos } from "./odontograma-en-ninos"
import { guide as plan } from "./plan-de-tratamiento-odontologico"
import { guide as presupuesto } from "./presupuesto-dental"
import { plainText } from "./rich"
import type { Guide, GuideSheet } from "./types"

export type { Guide, GuideFigure, GuideSheet, GuideStep, GuideVideo, Rich } from "./types"

/** Las guías, en el orden del índice. Una nueva se suma aquí y con su página en `src/pages/guias/`. */
export const GUIDES: readonly Guide[] = [
  odontograma,
  ninos,
  periodontograma,
  historia,
  cie10,
  consentimiento,
  plan,
  presupuesto,
  caja,
]

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
  "historia-clinica": "/guias/historia-clinica-odontologica.pdf",
  consentimiento: "/guias/consentimiento-informado-dental.pdf",
  "cierre-de-caja": "/guias/cierre-de-caja.pdf",
  "plan-de-tratamiento": "/guias/plan-de-tratamiento-odontologico.pdf",
  periodontograma: "/guias/periodontograma.pdf",
  "cie10-odontologia": "/guias/cie10-odontologia.pdf",
}

/** Qué es cada plantilla, en palabras: el texto de su imagen. */
export const SHEET_NAMES: Record<GuideSheet, string> = {
  odontograma: "odontograma de adultos en blanco",
  "odontograma-ninos": "odontograma de niños en blanco",
  presupuesto: "presupuesto dental en blanco, por fases",
  "historia-clinica": "historia clínica odontológica en blanco",
  consentimiento: "consentimiento informado dental en blanco",
  "cierre-de-caja": "cierre de caja en blanco, con el arqueo",
  "plan-de-tratamiento": "plan de tratamiento odontológico en blanco, por fases",
  periodontograma: "periodontograma en blanco, con la placa",
  "cie10-odontologia": "lista de códigos CIE-10 de odontología",
}

/**
 * Las dos imágenes de cada plantilla, que escribe el mismo comando junto al PDF: la hoja (la tarjeta
 * de descarga, Google Imágenes) y la de compartir el enlace (1200 × 630).
 */
export function sheetImages(sheet: GuideSheet): { page: string; share: string } {
  const base = SHEET_FILES[sheet].replace(/\.pdf$/, "")
  return { page: `${base}.webp`, share: `${base}-og.png` }
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
    datePublished: guide.published,
    dateModified: guide.updated,
    inLanguage: "es",
    mainEntityOfPage: url,
    url,
    // Google pide una imagen para mostrar el artículo con foto: la hoja que se descarga.
    image: guide.sheets.flatMap((item) => {
      const images = sheetImages(item.sheet)
      return [new URL(images.share, site).toString(), new URL(images.page, site).toString()]
    }),
    author: { "@id": publisher },
    publisher: { "@id": publisher },
  }
}
