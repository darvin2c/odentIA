import {
  CORE_VITAL_KEYS,
  DENTAL_IMAGING_TYPES,
  DENTAL_MEDICATION_CATALOG,
  type DiagnosisSystemKey,
  type ImagingType,
  type MedicationCatalog,
  type RegistrationAnswers,
  SUGGESTED_CONSENT_TEMPLATES,
  type SuggestedConsentTemplate,
  type VitalSignKey,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { DictationKind } from "@odentia/db/schema/clinical"
import type { SQL } from "drizzle-orm"
import type { DocumentCheckFacts } from "./document-check.js"
import { validation } from "./errors.js"
import type { TimelineItem } from "./patient-history.js"
import { NO_CATALOG, type ProductCatalog } from "./product-catalog.js"

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
  /**
   * Indicar no es hacer: al indicar un tratamiento, lo que su ámbito pide y aún
   * no se sabe (odentIA: la pieza o la cara) puede quedar por definir. Lo que sí
   * se dijo se valida igual; al hacerlo (el procedimiento) se exige completo.
   */
  pending?: boolean
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
  /**
   * Las marcas de estos sitios en la grilla del producto, para la hoja del presupuesto
   * (odentIA: las piezas FDI). Sin él, o sin ninguna marca, no hay grilla.
   */
  chart?(
    rows: SiteColumns[],
  ): { label: string; rows: Array<Array<{ label: string; marked: boolean }>> } | null
  /** El sitio como `bodySite` de FHIR para la exportación de la historia; null sin sitio. */
  bodySite(row: SiteColumns): { text: string } | null
  /** Lo que se le dice a quien manda un sitio suelto que no vale («Pieza FDI inválida: 19»). */
  invalid(value: unknown): string
  /**
   * Lo que un tratamiento indicado dejó por definir para su ámbito (odentIA: la
   * pieza, la cara) y cómo se le pide a quien lo hace. Sin él, nada queda pendiente.
   */
  pending?(row: SiteColumns, scope: string): { fields: string[]; ask: string } | null
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

/** Una parte del examen como Observation de FHIR (categoría `exam`). */
export interface ExamObservation {
  /** Lo que distingue la parte dentro de la atención («piel»), para su id. */
  key: string
  /** Qué se examinó, en palabras («Piel»). */
  text: string
  /** Lo encontrado; null si no se examinó (data-absent-reason `not-performed`). */
  value: string | null
  /** N, sin alteraciones; A, con hallazgos (v3 ObservationInterpretation); null si no se examinó. */
  interpretation: "N" | "A" | null
}

/**
 * El examen físico de la atención (`encounter.examination`): cada producto
 * dice qué se guarda y cómo se cuenta en la historia (odentIA: el de la boca;
 * latidIA: por sistemas, issue 229).
 */
export interface ProductExamination {
  /** Lo que llega → lo que se guarda; null si queda vacío. Lanza `validation` si no vale. */
  parse(input: unknown): Record<string, unknown> | null
  /** El examen en la copia de la historia, una línea por parte; vacío si no lo lleva. */
  recordLines(value: unknown): string[]
  /** El examen en la exportación FHIR de la historia; vacío si no lo exporta. */
  observations(value: unknown): ExamObservation[]
}

/** Un producto sin examen propio: la atención no lo guarda. */
export const NO_EXAMINATION: ProductExamination = {
  parse: (input) => {
    if (input !== null && input !== undefined) throw validation("Esta clínica no registra examen")
    return null
  },
  recordLines: () => [],
  observations: () => [],
}

/** Lo que la persona declaró de su salud en el registro (`registrationAnswersSchema.health`). */
export type DeclaredHealth = NonNullable<RegistrationAnswers["health"]>

/**
 * La «Entrevista de salud» de la ficha (`patient_anamnesis.answers`): lo común
 * (personales y familiares) y lo de cada producto (odentIA: sus antecedentes
 * odontológicos; latidIA: embarazo y lactancia con fecha, gineco-obstétricos,
 * hábitos y vacunas, issue 229).
 */
export interface ProductInterview {
  /** Valida y limpia lo del producto; lo común queda igual. Lanza `validation`. `today`: el día de la clínica. */
  check(answers: Record<string, unknown>, today: string): Record<string, unknown>
  /** Lo que la persona declaró en su registro, ya con las claves de la entrevista. */
  declared(health: DeclaredHealth, today: string): Record<string, unknown>
}

/** Lo que se respondió de un grupo, sin lo vacío. */
export function answeredOf(group: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(group ?? {}).filter(([, value]) => value !== "" && value !== undefined),
  )
}

/** La entrevista común: los antecedentes personales que declaró, con sus mismas claves. */
export const COMMON_INTERVIEW: ProductInterview = {
  check: (answers) => answers,
  declared: (health) => {
    const personal = answeredOf(health.personal)
    return Object.keys(personal).length ? { antecedentesPersonales: personal } : {}
  },
}

/** Lo que el producto revisa al emitir una receta, además de las alergias. */
export interface PrescribingReview {
  /** Lo que impide emitir (latidIA: un controlado, el peso de un niño). */
  errors: string[]
  /** Lo que se receta solo con motivo, como una alergia (latidIA: contraindicado en el embarazo). */
  warnings: string[]
}

/**
 * La receta del producto (issue 229, decisión 12): qué receta y reconoce como
 * alergia, y qué más revisa al emitir.
 */
export interface ProductPrescribing {
  catalog: MedicationCatalog
  review(
    tx: Db,
    moment: {
      orgId: string
      patientId: string
      items: ReadonlyArray<{ genericName: string }>
      weightKg: number | null
    },
  ): Promise<PrescribingReview>
}

/** La receta de siempre: la lista dental y solo las alergias. */
export const DENTAL_PRESCRIBING: ProductPrescribing = {
  catalog: DENTAL_MEDICATION_CATALOG,
  review: async () => ({ errors: [], warnings: [] }),
}

/** Una sugerencia de Clío ya revisada: lista para confirmar, o por revisar con su motivo. */
export interface DictationPrepared {
  payload: Record<string, unknown>
  status: "lista" | "por_revisar"
  note: string | null
}

/**
 * Lo que Clío dicta de cada producto (ADR 0012 y 0079). Lo común ordena,
 * corrige, confirma y descarta las sugerencias de la atención (la consulta,
 * los diagnósticos, el plan, la receta y los controles); el producto dice qué
 * clases propias suma (odentIA: los hallazgos del odontograma), cómo se dice su
 * «dónde» y qué operación ejecuta cada una al confirmarse.
 */
export interface ProductDictation {
  /** Las clases de sugerencia propias del producto, además de las comunes. */
  kinds: readonly DictationKind[]
  /** Lo del producto que va en la parte fija de las instrucciones (odentIA: los hallazgos que se dictan). */
  catalogText(): string
  /** Lo que el producto lee una vez para revisar sus sugerencias (odentIA: si el país exige la variante del hallazgo). */
  context(tx: Db, orgId: string): Promise<unknown>
  /** El «dónde» dictado de un diagnóstico o una indicación, en los valores del sistema; `invalid`: por qué no vale. */
  normalizeSite(payload: Record<string, unknown>): {
    payload: Record<string, unknown>
    invalid: string | null
  }
  /** El «dónde» en palabras («Pieza 16 · cara oclusal»); vacío sin sitio. */
  siteWords(payload: Record<string, unknown>): string
  /**
   * Una indicación ajustada al ámbito de su servicio: lo que no lleva se quita y
   * lo que le falta queda a la vista sin impedir confirmarla (ADR 0099). Con
   * `done` es lo que se hizo hoy: eso sí necesita su sitio, así que lo que falta
   * la deja por revisar, con la pregunta.
   */
  fitToScope(
    payload: Record<string, unknown>,
    scope: string | null,
    done?: boolean,
  ): DictationPrepared
  /** Revisa una sugerencia de una clase propia, ya validada con su operación. */
  prepare(
    tx: Db,
    kind: DictationKind,
    payload: Record<string, unknown>,
    context: { diagnosisSystem: DiagnosisSystemKey; product: unknown },
  ): Promise<DictationPrepared>
  /** Lo que entraría a la historia, en pocas palabras, de una clase propia. */
  summarize(kind: DictationKind, payload: Record<string, unknown>): string
  /** Cómo se le nombra al asistente una sugerencia pendiente de una clase propia, después de su clase. */
  modelLabel(kind: DictationKind, payload: Record<string, unknown>): string
  /** Qué decía un campo del producto antes de una corrección por voz («pieza 16»); null si el campo no es suyo. */
  describeField(key: string, before: Record<string, unknown>): string | null
  /** Lo que hace iguales dos sugerencias pendientes de una clase (odentIA: pieza, hallazgo y caras); null si no se comparan. */
  sameKey(kind: DictationKind, payload: Record<string, unknown>): string | null
  /** Confirma una sugerencia de una clase propia con la operación de siempre; devuelve lo que creó. */
  confirm(
    tx: Db,
    moment: EncounterMoment,
    kind: DictationKind,
    payload: Record<string, unknown>,
  ): Promise<string | null>
}

export interface ProductHooks {
  /** El «dónde» del producto. */
  site: ProductSite
  /** La receta: su lista y lo que revisa al emitir. */
  prescribing: ProductPrescribing
  /** Los tipos de imagen que se suben (odentIA: los de la boca; latidIA: ecografía, tomografía…). */
  imaging: readonly ImagingType[]
  /** Los consentimientos que sugiere a la clínica, como borrador (odentIA: anestesia, exodoncia…). */
  consentSuggestions: readonly SuggestedConsentTemplate[]
  /** La «Entrevista de salud»: lo del producto. */
  interview: ProductInterview
  /** El examen físico de la atención. */
  examination: ProductExamination
  /** Los signos vitales que registra la atención (los ocho de siempre; latidIA suma dos). */
  vitals: readonly VitalSignKey[]
  /** Los tipos de tratamiento de su biblioteca y las especialidades de cada país. */
  catalog: ProductCatalog
  /** Lo que Clío dicta en sus clínicas; null si no dicta (la app médica, hasta tener su dictado). */
  dictation: ProductDictation | null
  /**
   * Si lo indicado espera la respuesta a un presupuesto (odentIA) o queda
   * aceptado al indicarlo (latidIA, decisión 15 del issue 229). Sin él, el
   * presupuesto es opcional: nada lo exige para agendar, vincular ni realizar.
   */
  budgetRequired: boolean
  /**
   * «Invitar a volver»: los meses sin venir que lo disparan y los que pasan
   * entre una invitación y la siguiente (odentIA 6, como la limpieza dental;
   * latidIA 12, decisión 16 del issue 229). Es también «Sin venir» de Reportes.
   */
  recallMonths: number
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
  /** El nombre de una fase en el papel; sin nombre (una sola fase), el presupuesto no habla de etapas. */
  phaseWords?(phase: string): string | null
  /**
   * Lo que un documento que solo existe en este producto dice al comprobarlo con su
   * QR (odentIA: el odontograma firmado). Sin él, ese documento no se comprueba.
   */
  documentCheck?(
    tx: Db,
    orgId: string,
    type: string,
    id: string,
  ): Promise<DocumentCheckFacts | null>
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
  prescribing: DENTAL_PRESCRIBING,
  imaging: DENTAL_IMAGING_TYPES,
  consentSuggestions: SUGGESTED_CONSENT_TEMPLATES,
  interview: COMMON_INTERVIEW,
  examination: NO_EXAMINATION,
  vitals: CORE_VITAL_KEYS,
  catalog: NO_CATALOG,
  dictation: null,
  budgetRequired: true,
  recallMonths: 6,
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
