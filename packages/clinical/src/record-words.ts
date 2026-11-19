/**
 * Palabras de la ficha que también dicen los papeles y la copia de la historia, en un solo
 * lugar: la pantalla y el servidor no las escriben cada uno a su modo.
 */

/** Clasificación ASA del estado físico (ASA Physical Status Classification System). */
export const ASA_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["I", "ASA I · sano"],
  ["II", "ASA II · enfermedad sistémica leve"],
  ["III", "ASA III · enfermedad sistémica grave"],
  ["IV", "ASA IV · amenaza constante para la vida"],
  ["V", "ASA V · moribundo"],
  ["VI", "ASA VI · muerte cerebral (donante)"],
]

/** «ASA II · enfermedad sistémica leve» de lo guardado; null sin clasificar (QA del 6 nov: no salía en ningún resumen). */
export function asaLabel(value: string | null | undefined): string | null {
  return ASA_OPTIONS.find(([key]) => key === value)?.[1] ?? null
}

/** «Ana Torres, Cirujano dentista, COP 12345»: quién firmó, con lo que decía su perfil al firmar. */
export function signerWords(s: {
  name: string | null | undefined
  title?: string | null
  registration?: string | null
}): string | null {
  return [s.name, s.title, s.registration].filter((part) => !!part?.trim()).join(", ") || null
}
