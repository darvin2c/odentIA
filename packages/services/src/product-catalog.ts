/**
 * Lo que cada producto pone en el catálogo de servicios (ADR 0079): los tipos
 * de tratamiento de su biblioteca, con qué palabras los busca el agente y las
 * especialidades del país que los reciben. Lo común no conoce los tipos: los
 * pide al producto de la clínica (`productHooks`).
 */

/** Un tipo de tratamiento de la biblioteca (odentIA: «Restauradora»). Uso interno: fase del plan y palabras del agente. */
export interface CatalogKind {
  key: string
  name: string
}

/** Una especialidad del país y los tipos de la biblioteca que recibe (ADR 0069). */
export interface CatalogSpecialty {
  key: string
  name: string
  /** El tipo que toma un servicio propio de esta especialidad, o null. */
  kind: string | null
  receives: readonly string[]
}

export interface ProductCatalog {
  /** Los tipos de tratamiento, en su orden. */
  kinds: readonly CatalogKind[]
  /** Con qué palabras pide la gente cada tipo, para el índice del agente («limpieza, flúor»). */
  kindWords: Readonly<Record<string, string>>
  /** Las especialidades con que nace una clínica del país (null: aún sin país). */
  specialties(country: string | null): readonly CatalogSpecialty[]
}

/** Un producto sin biblioteca ni especialidades propias. */
export const NO_CATALOG: ProductCatalog = {
  kinds: [],
  kindWords: {},
  specialties: () => [],
}

export function isCatalogKind(catalog: ProductCatalog, value: unknown): value is string {
  return typeof value === "string" && catalog.kinds.some((kind) => kind.key === value)
}

/** La especialidad que recibe un tipo de la biblioteca: así toma la suya un servicio de la biblioteca. */
export function specialtyForKind(specialties: readonly CatalogSpecialty[], kind: string): CatalogSpecialty | null {
  return specialties.find((item) => item.receives.includes(kind)) ?? null
}

/** El tipo que toma un servicio propio por su especialidad (su clave), o null. */
export function kindOfSpecialty(
  catalog: ProductCatalog,
  specialties: readonly CatalogSpecialty[],
  specialtyKey: string | null | undefined,
): string | null {
  if (!specialtyKey) return null
  const kind = specialties.find((item) => item.key === specialtyKey)?.kind
  if (kind) return kind
  // Una especialidad que la clínica conservó con la clave de un tipo de la
  // biblioteca (las de antes de ADR 0069, p. ej. «Estética») sigue siendo ese tipo.
  return isCatalogKind(catalog, specialtyKey) ? specialtyKey : null
}
