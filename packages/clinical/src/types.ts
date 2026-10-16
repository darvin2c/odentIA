/**
 * Tipos del dominio clínico del odontograma: numeración FDI (ISO 3950) y
 * hallazgos con la nomenclatura de la NTS 188-MINSA/DGIESP-2022, que en Perú
 * es además la norma (siglas y variante obligatorias; ADR 0036). Valores en
 * inglés, etiquetas en español.
 */

/** Tipo anatómico de pieza. En temporal, 54/55/64/65/74/75/84/85 son molares. */
export type ToothType = "incisor" | "canine" | "premolar" | "molar"

/** Superficie dentaria. Valores en inglés; el español vive en `surfaceLabel`. */
export type Surface =
  | "mesial"
  | "distal"
  | "buccal"
  | "facial"
  | "lingual"
  | "palatal"
  | "occlusal"
  | "incisal"

/** Alcance gráfico del hallazgo sobre el odontograma oficial. */
export type FindingScope = "tooth" | "surface" | "pair" | "span" | "arch"

/** Color normativo: fijo rojo/azul, dual según estado, o sin color (solo texto libre). */
export type FindingColorKind = "red" | "blue" | "quality" | "none"

/** Variante excluyente de un hallazgo (sigla oficial en `abbreviation`; "" = sin sigla normada). */
export interface FindingVariant {
  value: string
  label: string
  abbreviation: string
}

export interface FindingDefinition {
  code: string
  label: string
  /** Sección normativa: "6.1.1".."6.1.38" o "5.15" (observación clínica). */
  section: string
  scope: FindingScope
  color: FindingColorKind
  /** Descripción del símbolo gráfico normativo. */
  symbol: string
  variants?: readonly FindingVariant[]
  /**
   * Cómo se llama la variante en palabras clínicas («Profundidad» en la caries,
   * «Material» en la restauración): así se pide fuera de un país con
   * odontograma oficial, donde es opcional y no lleva sigla.
   */
  variantName?: string
  /** Verdadero cuando la norma solo permite registrarlo con observación clínica directa. */
  requiresEvidence?: boolean
  /** Verdadero cuando exige trazo libre (p. ej. fractura). */
  requiresDrawing?: boolean
}

export interface FindingDetails {
  variant?: string
  quality?: "good" | "poor"
  /** Grado de movilidad patológica (entero >= 1; no existe M0). */
  grade?: number
  direction?: "clockwise" | "counterclockwise"
  positions?: string[]
  /** Todas las piezas del hallazgo incluyendo la principal (par, tramo o arcada). */
  relatedTeeth?: number[]
  /** Pilares del puente (solo prótesis parcial fija). */
  abutmentTeeth?: number[]
  clinicallyObserved?: boolean
  /** Trazos libres normalizados 0..100 sobre el dibujo de pieza completa (viewBox 0 0 24 28). */
  drawing?: number[][][]
  specifications?: string
  observations?: string
}

/**
 * Lo que cambia con el país de la clínica al validar un hallazgo
 * (`clinicalProfileFor(...).odontogram`): con odontograma oficial (Perú) la
 * variante es obligatoria como en la norma; sin él, opcional.
 */
export interface ValidateFindingOptions {
  strictVariants: boolean
}

/** Carga de registro de hallazgo nuevo. Sin `status`: todo registro nace observado. */
export interface FindingInput {
  toothNumber: number
  condition: string
  surfaces?: string[]
  details?: FindingDetails
  note?: string | null
  diagnosisCode?: string | null
  encounterId?: string
}

export interface FindingRecord {
  id: string
  toothNumber: number
  condition: string
  surface?: string | null
  status: string
  details?: FindingDetails
  needsReview?: boolean
  createdAt?: string | Date
  voidedAt?: string | Date | null
  /** Tratado: vigente hasta esa fecha, ya no es un problema por tratar. */
  resolvedAt?: string | Date | null
}
