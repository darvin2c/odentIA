import type { Db } from "@odentia/db"
import type { SQL } from "drizzle-orm"
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
  closingParts: async () => ({}),
  encounterDetailParts: async () => ({}),
  encounterFinalized: async () => ({}),
  encounterVoided: async () => {},
  treatmentDone: async () => {},
  treatmentUndone: async () => {},
  summaryParts: async () => ({}),
  recordSections: async () => [],
  timelineSources: () => [],
  timelineItems: async () => new Map(),
  encounterParts: async () => new Map(),
}
