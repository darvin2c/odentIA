import type { Db } from "@odentia/db"
import type { SQL } from "drizzle-orm"
import { validation } from "./errors.js"
import type { TimelineItem } from "./patient-history.js"

/**
 * Lo que cada producto hace en los momentos de lo común (ADR 0079): lo común
 * no sabe de odontogramas ni de periodontogramas; en cada momento le pregunta
 * al producto de la clínica (`products.ts`) y devuelve lo que este agrega.
 * Un producto que no hace nada en un momento usa `NO_PRODUCT_HOOKS`.
 */

/** Lo que un producto agrega a una respuesta común, con su nombre (`odontogram`, `periodontal`…). */
export type ProductParts = Record<string, unknown>

/** La atención de la que se habla y quién actúa. */
export interface EncounterMoment {
  orgId: string
  actorUserId: string
  patientId: string
  encounterId: string
}

/** Dónde, como lo guardan las tablas comunes: sistema, código y calificadores (bodySite de FHIR). */
export interface SiteColumns {
  siteSystem: string | null
  siteCode: string | null
  siteQualifiers: string[]
}

/** Dónde, como lo dice la API del producto (odentIA: `toothNumber`, `surfaces`, `quadrant`, `arch`). */
export type SiteFields = Record<string, unknown>

/** Dónde se hace un tratamiento según su ámbito, y cuántas caras admite. */
export interface SiteRules {
  scope: string
  surfaces?: { min: number | null; max: number | null }
}

/**
 * El «dónde» de cada producto (ADR 0079). Lo común guarda y filtra el sitio
 * común; qué campos tiene, qué valores valen y cómo se dice lo pone el producto.
 */
export interface ProductSite {
  /** El sistema de códigos del producto (odentIA: ISO 3950); null si no tiene sitio. */
  system: string | null
  /** Los campos con que la API dice el sitio (odentIA: toothNumber, surfaces, quadrant, arch). */
  inputs: readonly string[]
  /** El ámbito de un sitio suelto, el que admite el lote de varios (odentIA: «tooth»); null si no hay. */
  looseScope: string | null
  /** Los ámbitos que puede tener un servicio (odentIA: general, pieza, caras, cuadrante y arcada). */
  scopes: readonly string[]
  /** Lo guardado → lo que dice la API. */
  fields(row: SiteColumns): SiteFields
  /**
   * Lo que llegó → lo que se guarda. Con reglas, valida el sitio con el ámbito
   * del servicio; sin ellas, acepta cualquier sitio válido o ninguno. Lanza
   * `validation` si no vale.
   */
  columns(input: SiteFields, rules?: SiteRules): SiteColumns
  /** El código de un sitio suelto (odentIA: el número de una pieza), para filtros y listas; null si no vale. */
  code(value: unknown): string | null
  /** Lo contrario: lo que la API dice de un código (odentIA: el número de la pieza); null si no es uno suelto. */
  value(code: string | null | undefined): number | null
  /**
   * El sitio en palabras, para papeles y resúmenes; null sin sitio. Corto: lo
   * que se hace («pieza 16»); largo, con sus calificadores («pieza 16 (occlusal)»);
   * entero, como título y también para las áreas («Pieza 16 (occlusal)»,
   * «Cuadrante 1», «Arcada superior»).
   */
  words(row: SiteColumns, form?: "short" | "long" | "full"): string | null
  /** El sitio como `bodySite` de FHIR para la exportación de la historia; null sin sitio. */
  bodySite(row: SiteColumns): { text: string } | null
  /** Lo que se le dice a quien manda un sitio suelto que no vale («Pieza FDI inválida: 19»). */
  invalid(value: unknown): string
}

/** Un producto sin «dónde»: no guarda sitio ni lo dice. */
export const NO_SITE: ProductSite = {
  system: null,
  inputs: [],
  looseScope: null,
  scopes: ["general"],
  fields: () => ({}),
  columns: (input) => {
    const given = Object.values(input).some(
      (value) => value != null && !(Array.isArray(value) && value.length === 0),
    )
    if (given) throw validation("Esta clínica no registra dónde")
    return { siteSystem: null, siteCode: null, siteQualifiers: [] }
  },
  code: () => null,
  value: () => null,
  words: () => null,
  bodySite: () => null,
  invalid: () => "Esta clínica no registra dónde",
}

/** Un diagnóstico que propone lo que el producto registró, con su sitio. */
export interface DiagnosisCandidate {
  code: string
  /** Lo que lo propone, en palabras («Lesión de caries dental»). */
  finding: string
  site: SiteColumns
}

/** De dónde salen los diagnósticos propuestos: la atención y, si se está marcando, lo que se marca. */
export interface DiagnosisQuery {
  orgId: string
  system: string
  patientId?: string | null
  encounterId?: string | null
  /** Lo que se está marcando, como lo dice la API del producto (odentIA: hallazgo, variante, pieza y caras). */
  finding?: SiteFields | null
}

/** Los datos del profesional que firma la atención, como quedan en ella. */
export interface EncounterSigner {
  name: string
  title: string
  registration: string
}

/** Una sección de la copia de la historia que agrega el producto. */
export interface RecordSection {
  title: string
  lines: string[]
  /** Lo que dice la sección sin líneas («Sin hallazgos registrados.»). */
  empty: string
}

/** Qué hechos de la historia se piden: tipos, si van fuera de su atención y la pieza o sitio. */
export interface TimelineQuery {
  orgId: string
  patientId: string
  types: readonly string[]
  /** Las atenciones también se piden: lo registrado en ellas va dentro de su atención. */
  outsideEncountersOnly: boolean
  tooth: number | null
}

export interface ProductHooks {
  /** El «dónde» del producto. */
  site: ProductSite
  /** Si Clío dicta en sus clínicas (odentIA sí; la app médica, cuando tenga su dictado). */
  dictates: boolean
  /**
   * «¿Se puede cerrar?»: lo que el producto informa antes de firmar (odentIA:
   * el odontograma que se firmará y el periodontograma). Informa, no bloquea.
   */
  closingParts(tx: Db, moment: Omit<EncounterMoment, "actorUserId">): Promise<ProductParts>
  /** Lo que el producto agrega al detalle de la atención (odentIA: sus hallazgos del odontograma). */
  encounterDetailParts(tx: Db, moment: Omit<EncounterMoment, "actorUserId">): Promise<ProductParts>
  /** Al firmar la atención, ya cerrada: lo que el producto deja hecho, y lo que el cierre informa. */
  encounterFinalized(
    tx: Db,
    moment: EncounterMoment & { at: Date; signer: EncounterSigner },
  ): Promise<ProductParts>
  /** Al anular la atención: lo que el producto registró en ella también se anula. */
  encounterVoided(tx: Db, moment: EncounterMoment & { at: Date; reason: string }): Promise<void>
  /** Un tratamiento del plan quedó realizado en la atención (odentIA: lo tratado queda dibujado). */
  treatmentDone(tx: Db, moment: EncounterMoment & { planItemId: string }): Promise<void>
  /** Un tratamiento dejó de estar realizado porque se anuló su procedimiento. */
  treatmentUndone(
    tx: Db,
    moment: EncounterMoment & { planItemId: string; reason: string; at: Date },
  ): Promise<void>
  /** Lo que el producto agrega al resumen de la persona (odentIA: diagnósticos por pieza y «Encías»). */
  summaryParts(tx: Db, scope: { orgId: string; patientId: string }): Promise<ProductParts>
  /** Las secciones que el producto agrega a la copia de la historia (odentIA: el odontograma). */
  recordSections(tx: Db, scope: { orgId: string; patientId: string }): Promise<RecordSection[]>
  /** Las fases del plan del producto, en su orden (odentIA: urgencia → mantenimiento). */
  planPhases: readonly string[]
  /** La fase que propone un tipo de tratamiento de la biblioteca. */
  phaseFor(kind: string | null): string
  /** Cuántas caras admite un tratamiento de la biblioteca (odentIA: su regla dental); null si no dice. */
  templateSurfaceLimits(
    tx: Db,
    templateId: string,
  ): Promise<{ min: number | null; max: number | null } | null>
  /**
   * Un tratamiento recién indicado: lo que el producto anota con él (odentIA:
   * el hallazgo que lo motivó, que valida del mismo paciente y vigente).
   */
  planItemCreated(
    tx: Db,
    moment: {
      orgId: string
      patientId: string
      item: { id: string; organizationId: string; patientId: string }
      input: SiteFields
    },
  ): Promise<void>
  /** Lo que el producto agrega a cada tratamiento del plan (odentIA: `odontogramEntryId`). */
  planItemParts(
    tx: Db,
    orgId: string,
    itemIds: readonly string[],
  ): Promise<Map<string, ProductParts>>
  /** Lo que el producto agrega al recorrido de un tratamiento (odentIA: su hallazgo de origen). */
  journeyParts(
    tx: Db,
    scope: { orgId: string; patientId: string; planItemId: string },
  ): Promise<ProductParts>
  /** Los diagnósticos que propone lo registrado (odentIA: los hallazgos del odontograma). */
  diagnosisCandidates(tx: Db, query: DiagnosisQuery): Promise<DiagnosisCandidate[]>
  /** Qué códigos de una lista van primero en el buscador (expresión regular de PostgreSQL); null: ninguno. */
  preferredDiagnoses(system: string): string | null
  /** La historia: consultas que listan los hechos propios del producto (id, kind, created_at). */
  timelineSources(query: TimelineQuery): SQL[]
  /** La historia: cada hecho propio del producto ya armado, por su id. */
  timelineItems(
    tx: Db,
    orgId: string,
    idsOf: (type: string) => string[],
  ): Promise<Map<string, TimelineItem>>
  /** Lo que el producto agrega a cada atención de la historia (odentIA: su periodontograma). */
  encounterParts(
    tx: Db,
    orgId: string,
    encounterIds: readonly string[],
  ): Promise<Map<string, ProductParts>>
}

/** Un producto que no agrega nada en ningún momento. */
export const NO_PRODUCT_HOOKS: ProductHooks = {
  site: NO_SITE,
  dictates: false,
  closingParts: async () => ({}),
  encounterDetailParts: async () => ({}),
  encounterFinalized: async () => ({}),
  encounterVoided: async () => {},
  treatmentDone: async () => {},
  treatmentUndone: async () => {},
  summaryParts: async () => ({}),
  recordSections: async () => [],
  planPhases: ["basica"],
  phaseFor: () => "basica",
  templateSurfaceLimits: async () => null,
  planItemCreated: async () => {},
  planItemParts: async () => new Map(),
  journeyParts: async () => ({}),
  diagnosisCandidates: async () => [],
  preferredDiagnoses: () => null,
  timelineSources: () => [],
  timelineItems: async () => new Map(),
  encounterParts: async () => new Map(),
}

/** La fila con su sitio como lo dice el producto (odentIA: pieza, caras, cuadrante y arcada). */
/** Los campos del sitio que llegaron, sin los que no vinieron. */
export function siteInputOf(site: ProductSite, input: object): SiteFields {
  const given = input as SiteFields
  const out: SiteFields = {}
  for (const key of site.inputs) if (given[key] !== undefined) out[key] = given[key]
  return out
}

export function withSite<T extends SiteColumns>(site: ProductSite, row: T): T & SiteFields {
  return { ...row, ...site.fields(row) }
}
