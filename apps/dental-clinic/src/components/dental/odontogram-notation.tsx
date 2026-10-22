import {
  conditionLabel,
  type FindingDetails,
  findingAbbreviation,
  findingDefinition,
  type OdontogramStandardProfile,
  variantLabel,
} from "@odentia/dental"
import { createContext, useContext } from "react"
import { useDentalProfile } from "../../lib/org"

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

/** Cómo se pide la variante: con su sigla y obligatoria en Perú; por su nombre y opcional fuera. */
export function variantFieldLabel(
  official: OdontogramStandardProfile | null,
  condition: string,
): string {
  const def = findingDefinition(condition)
  const name = def?.variantName ?? "Variante"
  return official ? `${name} · sigla de la ${official.shortName}` : `${name} (opcional)`
}
