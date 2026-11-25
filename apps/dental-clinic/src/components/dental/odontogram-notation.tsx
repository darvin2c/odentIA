import {
  conditionLabel,
  type FindingDetails,
  findingAbbreviation,
  findingByVariant,
  findingColor,
  findingDefinition,
  type OdontogramStandardProfile,
  variantLabel,
} from "@odentia/dental"
import { createContext, useContext } from "react"
import { useDentalProfile } from "../../lib/dental/profile"

/**
 * Cómo se nombra un hallazgo según el país de la clínica (ADR 0036): con
 * odontograma oficial (Perú, NTS 188) se dicen las siglas y la variante es
 * obligatoria; en el resto, el hallazgo y su variante en palabras, sin siglas.
 * La forma de boca es la misma en todos los países.
 */
const NotationContext = createContext<OdontogramStandardProfile | null>(null)

/** Lo provee la pantalla del odontograma con el país de la clínica. */
export function OdontogramNotationProvider({ children }: { children: React.ReactNode }) {
  const official = useDentalProfile().odontogram
  return <NotationContext.Provider value={official}>{children}</NotationContext.Provider>
}

/** El odontograma oficial del país (Perú: NTS 188) o null: el núcleo internacional. */
export function useOdontogramNotation(): OdontogramStandardProfile | null {
  return useContext(NotationContext)
}

/**
 * El nombre corto de las variantes de nombre largo, para su pastilla: «Dentina» y no «Lesión de
 * caries a nivel de la dentina». El nombre entero sigue debajo de la elegida.
 */
const SHORT_VARIANT: Record<string, string> = {
  white_spot: "Mancha blanca",
  enamel: "Esmalte",
  dentin: "Dentina",
  pulpal_involvement: "Pulpa",
  unerupted: "No erupcionado",
  caries_extraction: "Extraído por caries",
  other_absence: "Ausente por otra razón",
  opacity: "Opacidades",
  pigmentation: "Pigmentación",
}

/**
 * Lo que dice la pastilla de una variante: con la norma, su nombre corto y la sigla («Dentina · CD»),
 * para que se entienda sin saberse las siglas (lienzo del 24 nov); sin ella, su nombre.
 */
export function variantChipLabel(
  official: OdontogramStandardProfile | null,
  variant: { value: string; label: string; abbreviation: string },
): string {
  if (!official || !variant.abbreviation) return variant.label
  return `${SHORT_VARIANT[variant.value] ?? variant.label} · ${variant.abbreviation}`
}

/**
 * Un hallazgo en una línea, sin repetir su nombre: «Corona metalcerámica · CMC · buen estado». El estado
 * va en palabras y no solo en color (WCAG 1.4.1; QA de voces del 24 nov).
 */
export function findingLine(
  official: OdontogramStandardProfile | null,
  entry: { condition: string; details?: FindingDetails; needsReview?: boolean },
): string {
  const abbr = officialAbbreviation(official, entry)
  const quality =
    entry.details?.quality === "good" ? "buen estado" : entry.details?.quality === "poor" ? "mal estado" : null
  return [findingByVariant(entry.condition, entry.details?.variant), abbr || null, quality]
    .filter(Boolean)
    .join(" · ")
}

/** El punto rojo o azul de la norma junto al hallazgo; nada si no tiene color. */
export function FindingDot({
  entry,
}: {
  entry: { condition: string; details?: FindingDetails; needsReview?: boolean }
}): React.JSX.Element | null {
  const paint = findingColor(entry)
  if (!paint) return null
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${paint === "red" ? "bg-red-600" : "bg-blue-600"}`}
    />
  )
}

/** Sigla del hallazgo solo con odontograma oficial; "" en el resto. */
export function officialAbbreviation(
  official: OdontogramStandardProfile | null,
  entry: { condition: string; details?: FindingDetails },
): string {
  if (!official) return ""
  try {
    return findingAbbreviation(entry) ?? ""
  } catch {
    return ""
  }
}

/**
 * El hallazgo dicho en una línea: «CD · Lesión de caries dental (dentina)» en
 * Perú; «Lesión de caries dental · Lesión de caries a nivel de la dentina»
 * fuera.
 */
export function findingWords(
  official: OdontogramStandardProfile | null,
  entry: { condition: string; details?: FindingDetails },
): string {
  const label = conditionLabel(entry.condition)
  const variant = variantLabel(entry.condition, entry.details?.variant)
  const abbr = officialAbbreviation(official, entry)
  if (official) return `${abbr ? `${abbr} · ` : ""}${label}${variant ? ` (${variant})` : ""}`
  return variant ? `${label} · ${variant}` : label
}

/**
 * Cómo se pide la variante: por su nombre y opcional en todos los países (17 nov: nunca se
 * decide por el profesional). Con odontograma oficial las opciones muestran su sigla.
 */
export function variantFieldLabel(condition: string): string {
  const def = findingDefinition(condition)
  return `${def?.variantName ?? "Variante"} (opcional)`
}
