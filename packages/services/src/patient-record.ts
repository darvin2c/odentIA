/**
 * La historia completa de una persona, para entregársela (issue 45 mínimo,
 * ADR 0080): un PDF para leer y un paquete HL7 FHIR R4 para que otra clínica
 * la cargue. Las imágenes, los documentos y cada papel emitido van en el ZIP
 * que arma `buildPatientRecordCopy` (`patient-record-copy.ts`).
 *
 * Lee todo lo clínico de la persona: solo la piden quienes leen la ficha
 * clínica (`clinical.read`). El envío a la propia persona lo hace el servidor
 * sin mostrarla a quien lo pide (Recepción).
 *
 * La copia dice lo mismo que la ficha (mesa del 18 nov): no tiene reglas
 * propias de qué decir. El plan sale de `listPlanItems` con sus palabras
 * (`planItemStateText`), los diagnósticos con las líneas de la Historia
 * (`encounterDiagnosisLines`), los controles de `listFollowUps`, la salud de
 * `getPatientHealth` y lo del producto de sus ganchos.
 */
import { createHash } from "node:crypto"
import {
  allergiesSaidUnknownOf,
  asaLabel,
  medicationAlertWords,
  planItemStateText,
  postalAddressText,
  sessionWords,
  showsSession,
  signerWords,
  type PregnancyToday,
} from "@odentia/clinical"
import {
  ALLERGY_CATEGORY_FHIR,
  ALLERGY_CRITICALITY_FHIR,
  ALLERGY_REMOVAL_FHIR,
  allergyRemovalReasonWords,
  ALLERGY_SEVERITY_FHIR,
  ALLERGY_TYPE_FHIR,
  ALLERGY_VERIFICATION_FHIR,
  type AllergyRemovalReason,
  APPOINTMENT_STATUS_FHIR,
  CONDITION_CLINICAL_STATUS_FHIR,
  CONSENT_STATUS_FHIR,
  DIAGNOSIS_SYSTEM_INFO,
  type DirectedMedicineDeclaration,
  ENCOUNTER_STATUS_FHIR,
  FHIR_ALLERGY_CLINICAL_SYSTEM,
  FHIR_ALLERGY_VERIFICATION_SYSTEM,
  FHIR_ATC_SYSTEM,
  FHIR_CONDITION_CLINICAL_SYSTEM,
  FHIR_CONDITION_VERIFICATION_SYSTEM,
  FHIR_CONSENT_CATEGORY,
  FHIR_CONSENT_SCOPE,
  FHIR_DATA_ABSENT_REASON_SYSTEM,
  FHIR_DATA_OPERATION_SYSTEM,
  FHIR_LOINC_SYSTEM,
  FHIR_OBSERVATION_CATEGORY_SYSTEM,
  FHIR_OBSERVATION_INTERPRETATION_SYSTEM,
  FHIR_PROVENANCE_PARTICIPANT_SYSTEM,
  FHIR_ROLE_CODE_SYSTEM,
  FHIR_UCUM_SYSTEM,
  FHIR_VERSION,
  FORM_FIELD_TYPE_FHIR,
  fhirCode,
  type HealthAtSigning,
  type HealthDeclarant,
  HEALTH_DECLARATION_REASON_LABELS,
  HL7_IDENTIFIER_TYPE_SYSTEM,
  hl7DocumentTypeCode,
  type InterviewEntry,
  isDiagnosisSystem,
  isCurrentMedication,
  isImageDocumentCategory,
  KINSHIP_LABELS,
  lowerFirst,
  MEDICATION_CLASSES,
  type MedicationClass,
  medicationClassOf,
  type MedicineClassAnswer,
  PREGNANCY_ENTRY_KEY,
  PRESCRIPTION_STATUS_FHIR,
  saidNoWords,
  changedWhenWords,
  saidWhenWords,
  SEX_LABELS,
  SEX_TO_FHIR_GENDER,
  visitAnswerLine,
  visitPainWords,
  VITAL_SIGNS,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import {
  appointmentPlanItem,
  clinicalNote,
  encounter,
  encounterDiagnosis,
  encounterProcedure,
  imagingStudy,
  imagingStudyFile,
  patient,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientDocument,
  patientFamilyHistory,
  patientMedication,
  prescription,
  prescriptionItem,
} from "@odentia/db/schema/clinical"
import { clinicalFormResponse, clinicalOrder, consentDocument, medicalLeave } from "@odentia/db/schema/clinical-forms"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { AGENT_NAMES } from "./agent-names.js"
import {
  type DeclaredHealthGroup,
  directedMedicineNotes,
  ENTRY_DECLARED_KEYS,
  getPatientHealth,
  type HealthDeclaration,
} from "./clinical.js"
import { and, asc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm"
import { ORDER_KIND_WORDS } from "./clinical-papers.js"
import { type DataRequestItem, listDataRequests, respondDataRequest } from "./data-requests.js"
import { diagnosisTitlesOf, namedDiagnosis } from "./diagnosis-codes.js"
import { loadDocumentClinic } from "./document-clinic.js"
import {
  chartNumber,
  type DocumentClinic,
  DocumentKit,
  dayTimeWords,
  dayWords,
  documentFormat,
  type Inline,
  SIZE,
  type Zone,
} from "./document-kit.js"
import { notFound, ServiceError, validation } from "./errors.js"
import {
  type DocumentChannelOption,
  deliverDocumentPdf,
  documentChannelsFor,
  requireDocumentConnection,
  type SendDeps,
} from "./financial-documents.js"
import { listFollowUps } from "./follow-ups.js"
import { formDiagnosesOf, formDiagnosisKey } from "./form-diagnoses.js"
import { civilDay, type FormRecord, type FormRecordItem, formRecordAt, loadFormRecords } from "./form-record.js"
import { proposeHealthChannel } from "./health-documents.js"
import { clinicToday } from "./inventory-stock.js"
import { orgClinicalProfile } from "./locale.js"
import { encounterDiagnosisLines } from "./patient-history.js"
import { getPatient, requirePatient } from "./patients.js"
import { listPlanItems } from "./plan.js"
import { FILE_TYPE_WORDS } from "./portal-papers.js"
import type { ExamObservation, ProductSite, RecordSection, SiteColumns } from "./product-hooks.js"
import { productHooks } from "./products.js"
import { issueRecordCopyLink, recordCopyCaption, recordCopyDayWords } from "./record-copy-link.js"
import { listDecisionRecipients } from "./responsibilities.js"
import { patientVisitAnswers, type VisitAnswerView } from "./visit-answers.js"

/** La pieza y las caras de un diagnóstico o procedimiento, sacadas de su sitio. */
/** Los tres grupos de antecedentes que se declaran y se revisan. */
type HealthTopic = "allergies" | "conditions" | "medications"

/** El sitio dicho por el producto: en palabras para el PDF y como `bodySite` para FHIR. */
type RecordSite = { siteWords: string | null; bodySite: ReturnType<ProductSite["bodySite"]> }

/**
 * Un papel emitido dentro de la copia: el mismo PDF que se envía y se imprime (con «ANULADA»
 * encima si se anuló), en su carpeta del ZIP. `related` es lo que el papel documenta, para
 * enlazarlo en FHIR (`DocumentReference.context.related`, `Consent.sourceAttachment`).
 */
/** Anulado después de firmar la atención: es «No se hizo», no una corrección del borrador. */
function notDoneAfterSigning(
  p: { voidedAt: Date | null },
  row: { status: string; finalizedAt: Date | null },
): boolean {
  return Boolean(p.voidedAt && row.status === "finalizada" && row.finalizedAt && p.voidedAt > row.finalizedAt)
}

export interface RecordPaperEntry {
  /** «receta», «orden», «descanso», «hoja», «consentimiento» o el del producto («signed_odontogram»). */
  kind: string
  id: string
  /** «Receta N.º 2», «Odontograma firmado · Inicio del plan de tratamiento». */
  label: string
  at: Date
  /** «Anulada el … : motivo», «sin firmar»; null si vale. */
  mark: string | null
  /** Quién lo firmó, con su título y colegiatura; null si no se sabe. */
  signer: string | null
  /** Su ruta dentro del ZIP: «papeles/Receta N.º 2 (anulada).pdf». */
  path: string
  contentType: string
  size: number
  /** SHA-256 en hex: la huella del papel emitido. */
  sha256: string
  /** SHA-1 en base64: lo que pide `Attachment.hash` de FHIR R4. */
  sha1: string
  related: { resourceType: string; id: string } | null
}

/** Un tratamiento del plan como lo dice la ficha: su decisión, sus sesiones, su camino y su cita. */
export interface RecordPlanItem {
  id: string
  title: string
  status: string
  decision: string
  /** «Aceptado», «Lo piensa», «No aceptó», «Realizado»…: la etiqueta de la ficha (`planItemStateText`). */
  stateWords: string
  siteWords: string | null
  bodySite: RecordSite["bodySite"]
  phase: string
  diagnosisName: string | null
  diagnosisSystem: string | null
  diagnosisCode: string | null
  sessionsDone: number
  plannedSessions: number
  /** Su camino, si compite con otro del mismo presupuesto y la persona aún no elige. */
  path: { budgetId: string; positions: number[]; name: string | null; pathCount: number; chosen: boolean } | null
  /** El motivo de un suspendido o cancelado. */
  statusReason: string | null
  /** «va después de…»: el tratamiento de la misma pieza que va antes. */
  waitsFor: string | null
  /** Su próxima cita en pie, si la tiene. */
  nextAppointmentAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * De quién es algo de la entrevista y de cuándo. `declared`: lo dijo alguien (la
 * persona, quien habla por ella, o el equipo que anotó lo que le dijeron), con la
 * misma señal de la ficha: la declaración que entró a su ficha en ese instante
 * (`patient_health_declaration`), no quién tenía la sesión abierta. `recorded`:
 * lo escribió alguien del equipo en Antecedentes.
 */
export type RecordSaid =
  | { kind: "declared"; by: HealthDeclarant; at: Date }
  | { kind: "recorded"; by: string | null; at: Date }

/**
 * La «Entrevista de salud» vigente como la cuenta el producto (`ProductInterview.record`),
 * con quién la dijo o la registró y cuándo. Lo que viene igual desde una versión
 * anterior dice de cuál: así lo que la persona declaró se sigue leyendo como suyo
 * aunque el equipo haya guardado después otra versión.
 */
export interface RecordInterview {
  version: number
  said: RecordSaid
  entries: Array<
    InterviewEntry & {
      since: RecordSaid | null
      /**
       * Lo dijo alguien y ningún profesional lo revisó todavía (hoy, el embarazo): quién y cuándo.
       * `repeatsVersion`: es quien y el día que ya dice el encabezado de la entrevista.
       */
      unreviewed?: { by: HealthDeclarant; at: Date | null; repeatsVersion?: boolean }
    }
  >
}

/**
 * Una declaración de salud tal como llegó (`patient_health_declaration`): lo que
 * la persona, o quien habló por ella, envió ese día, con quién y cuándo. No cambia
 * aunque el equipo corrija lo vigente: es la «declaración original» de la ficha.
 */
export interface RecordDeclaration {
  at: Date
  via: HealthDeclaration["via"]
  by: HealthDeclarant
  /** Por qué llegó antes de una cita: algo cambió, corrigió lo enviado o dijo que nada cambió (entrega 10). */
  reason: HealthDeclaration["reason"]
  /** Lo que respondió, en palabras; lo que dejó sin responder no sale. */
  entries: InterviewEntry[]
}

export interface PatientRecord {
  generatedAt: Date
  /** La clínica como la dice su papel. */
  clinic: DocumentClinic
  person: {
    patientId: string
    patientNumber: number
    displayName: string
    givenNames: string | null
    familyName: string | null
    docType: string | null
    docNumber: string | null
    docCountry: string | null
    birthDate: string | null
    sex: string | null
    phone: string | null
    email: string | null
    /** El domicilio como lo guarda la ficha (forma de FHIR Address) y en una línea; null sin domicilio. */
    address: { line: string | null; city: string | null; district: string | null; region: string | null; postalCode: string | null; country: string | null; text: string } | null
  }
  contacts: Array<{
    contactId: string
    displayName: string
    relationship: string
    detail: string | null
    phone: string | null
    isEmergency: boolean
  }>
  /** La ASA, con quién la clasificó y cuándo, como la ficha; null sin clasificar. */
  asa: { value: string; by: string | null; at: Date | null } | null
  /** El embarazo de hoy, con la regla común (`pregnancyToday`); null si no hay. */
  pregnancy: PregnancyToday | null
  /** Su «No sé» a las alergias (se le preguntó y no sabe), con quién y cuándo; null si no. */
  allergiesSaidUnknown: { by: HealthDeclarant; at: Date } | null
  /** Las notas clínicas (no las adendas), con su autor; las de una atención también van en ella. */
  clinicalNotes: Array<{ id: string; encounterId: string | null; note: string; authorName: string | null; createdAt: Date; siteWords: string | null }>
  /** Los controles, como el Plan (`listFollowUps`): por venir, hechos y cancelados con su motivo. */
  followUps: Array<{
    id: string
    title: string
    kind: string
    status: string
    dueAt: Date
    appointmentAt: Date | null
    overdue: boolean
    outcome: string | null
    cancelledReason: string | null
    completedAt: Date | null
    cancelledAt: Date | null
  }>
  /** Las órdenes (imagen, laboratorio, derivación), con su resultado o «sin resultado». */
  orders: Array<typeof clinicalOrder.$inferSelect & { kindWords: string; diagnosisName: string | null }>
  /** Los descansos médicos. */
  leaves: Array<typeof medicalLeave.$inferSelect & { diagnosisName: string | null }>
  /**
   * Lo retirado de sus archivos, nombrado con su tipo, fecha y motivo: sin el archivo ni su nombre
   * (el nombre puede ser el de otra persona: el archivo era suyo, no de ella).
   */
  retiredDocuments: Array<{ id: string; typeWords: string; at: Date; retiredAt: Date; reason: string | null; retiredBy: string | null }>
  /** Las tomografías completas, por documento, para `ImagingStudy`. */
  imagingStudies: Array<{
    documentId: string
    studyInstanceUid: string
    modality: string | null
    fileCount: number
    completedAt: Date | null
    series: Array<{ uid: string; count: number }>
  }>
  /**
   * Cada papel que va en la copia, con su archivo dentro del ZIP: lo llena quien arma la copia
   * (`buildPatientRecordCopy`). Vacío si se pide solo el PDF.
   */
  papers: RecordPaperEntry[]
  /** Lo que se nombra en la copia porque no se pudo incluir (un papel que no se leyó, una tomografía a medias). */
  missing: string[]
  allergies: Array<typeof patientAllergy.$inferSelect>
  /**
   * Las alergias que se quitaron, con quién y por qué: quitar nunca borra, y lo que llegó como
   * declarado no se lee como si siguiera en pie (auditor, A11).
   */
  removedAllergies: Array<typeof patientAllergy.$inferSelect & { removedByName: string | null }>
  conditions: Array<typeof patientCondition.$inferSelect>
  medications: Array<typeof patientMedication.$inferSelect>
  /** El día de la clínica de la copia: una medicina con fin anterior ya no la toma. */
  today: string
  /**
   * Quién revisó con ella sus antecedentes y cuándo, como lo dice la ficha; las
   * alergias tienen su propia revisión. null si nadie los revisó.
   */
  reviews: {
    history: { at: Date; by: string | null } | null
    allergies: { at: Date; by: string | null } | null
  }
  /**
   * Cómo quedó cada grupo en la revisión: «none» (niega), «recorded» (lo que hay
   * anotado) o «unknown» (no se le preguntó), y el «no» que ella dijo en su última
   * declaración de ese grupo, para no perderlo cuando nadie de la clínica lo preguntó.
   */
  groups: Record<
    HealthTopic,
    { state: string; saidNo: { by: HealthDeclarant; at: Date } | null }
  >
  /**
   * Lo que alguien dijo de su salud y ningún profesional revisó todavía, por
   * declaración: quién, cuándo y qué. Lo decide el servidor (`PatientHealth.declared`),
   * igual que para la ficha.
   */
  declared: DeclaredHealthGroup[]
  /**
   * Lo vigente que «dijo que cambió» (entrega 10), igual que en la ficha: no se lee como de hoy
   * (revisión final del 15 nov, dev H2). Nulo si nada.
   */
  changed: { by: HealthDeclarant; at: Date; allergies: string[]; conditions: string[]; medications: string[] } | null
  /**
   * Lo que declaró de su salud, tal como llegó, de lo más antiguo a lo más nuevo. Lo
   * que dijo en un formulario no se repite aquí: va con su formulario.
   */
  declarations: RecordDeclaration[]
  /** null si no hay nada que contar: nunca se guardó una entrevista, o la vigente quedó sin datos. */
  interview: RecordInterview | null
  /**
   * Lo que se sabe de las dos medicinas que se preguntan aparte (anticoagulante y huesos) cuando no
   * hay una de esa clase vigente: «dijo que no», «no sabe», «no se le preguntó» o «la tomó antes»
   * (QA de la entrega 6). Lo que toma ya está en sus medicinas.
   */
  medicineClasses: Array<{ group: MedicationClass; answer: MedicineClassAnswer["answer"]; said: boolean }>
  familyHistory: Array<typeof patientFamilyHistory.$inferSelect>
  encounters: Array<{
    row: typeof encounter.$inferSelect
    diagnoses: Array<typeof encounterDiagnosis.$inferSelect & RecordSite & { title: string | null }>
    /**
     * Los diagnósticos como los dice la Historia (`encounterDiagnosisLines`): nombre, código, el
     * término de la ficha, la pieza y su tipo («presuntivo», «definitivo»).
     */
    diagnosisLines: string[]
    /** Lo anulado de la atención, con su motivo: se corrigió, no se borró. */
    voided: string[]
    procedures: Array<typeof encounterProcedure.$inferSelect & RecordSite>
    /** Lo firmado y marcado después «No se hizo»: en FHIR viaja como `entered-in-error`. */
    notDone: Array<typeof encounterProcedure.$inferSelect & RecordSite>
    /** El examen como lo cuenta el producto: en líneas para el PDF y como Observations para FHIR. */
    exam: { lines: string[]; observations: ExamObservation[] }
    /** Lo corregido después de firmar, con quién y cuándo: también es parte de la historia. */
    addenda: Array<{ note: string; authorName: string | null; createdAt: Date }>
  }>
  /** Lo que agrega el producto de la clínica (odentIA: el odontograma vigente y el periodontograma). */
  productSections: RecordSection[]
  /** Las fases del plan del producto, en su orden, con su nombre en el papel. */
  planPhases: Array<{ key: string; words: string | null }>
  planItems: RecordPlanItem[]
  prescriptions: Array<{
    row: typeof prescription.$inferSelect
    items: Array<typeof prescriptionItem.$inferSelect>
  }>
  consents: Array<typeof consentDocument.$inferSelect & { siteWords: string | null; bodySite: RecordSite["bodySite"] }>
  /**
   * Las fichas finalizadas y lo que respondió la persona, revisado o no, con cada
   * pregunta, su respuesta y sus adendas o correcciones.
   */
  forms: FormRecord[]
  documents: Array<typeof patientDocument.$inferSelect>
  appointments: Array<typeof appointment.$inferSelect>
  /**
   * Lo que contó antes de cada cita (mesa del 13 nov, entrega 8), con su cita, cuándo y por dónde lo
   * envió, quién lo contó y quién lo vio al atender. El PDF lo trae en su apartado y en la atención
   * en que se vio; FHIR, como un `QuestionnaireResponse` por cita, dicho por quien lo contó.
   */
  visitAnswers: Array<VisitAnswerView & { encounterId: string | null }>
}

/** Cómo respondió a un grupo de su declaración: «No», «No sabe» o lo que anotó; null si no respondió. */
function declaredGroupWords(
  group: { state: string; items: ReadonlyArray<Record<string, unknown>> } | undefined,
  itemWords: (item: Record<string, unknown>) => string,
): string | null {
  if (!group || group.state === "unanswered") return null
  if (group.state === "none") return "No"
  if (group.state === "unknown") return "No sabe"
  return group.items.map(itemWords).join("; ") || null
}

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const joined = (...parts: string[]): string => parts.filter(Boolean).join(" · ")

/**
 * Cómo respondió a la pregunta de una clase de medicina («¿Tomas algún anticoagulante?»): «No»,
 * «No sabe» o la que dijo, con por qué y cómo la toma (los huesos); null si no respondió.
 */
function directedMedicineWords(answer: DirectedMedicineDeclaration | undefined): string | null {
  if (!answer || answer.state === "unanswered") return null
  if (answer.state === "none") return "No"
  if (answer.state === "unknown") return "No sabe"
  return joined(answer.detail?.trim() || "Sí, no dijo cuál", ...directedMedicineNotes(answer))
}

/**
 * Lo que trae una declaración, como lo respondió: su respuesta a «¿Cambió algo?», sus alergias,
 * enfermedades y medicinas (también el anticoagulante y los huesos, que se preguntan aparte), el
 * grupo sanguíneo, el embarazo con las semanas que dijo y lo demás de la entrevista, que cuenta el
 * producto (`interviewEntries`). «Nada cambió» no trae salud: sin su respuesta salía vacía (QA final
 * de formularios, H1 de desarrollo).
 */
function declarationEntries(
  health: HealthDeclaration["health"],
  interviewEntries: InterviewEntry[],
  reason: HealthDeclaration["reason"],
): InterviewEntry[] {
  const out: InterviewEntry[] = []
  const add = (key: string, label: string, value: string | null) => {
    if (value) out.push({ key, label, value })
  }
  if (reason === "cambio" || reason === "sin_cambios")
    add("cambio", "¿Cambió algo en su salud o en sus medicinas?", reason === "cambio" ? "Sí" : "No, sigue igual")
  add(
    "allergies",
    "Alergias",
    declaredGroupWords(health.allergies, (item) => {
      const severity = textOf(item.severity)
      return `${joined(textOf(item.substance), textOf(item.reaction))}${severity && severity !== "desconocida" ? ` (${severity})` : ""}`
    }),
  )
  add("conditions", "Enfermedades", declaredGroupWords(health.conditions, (item) => joined(textOf(item.name), textOf(item.notes))))
  for (const group of ["anticoagulants", "boneMedicines"] as const)
    add(group, MEDICATION_CLASSES[group].label, directedMedicineWords(health[group]))
  add(
    "medications",
    // Con las dos clases preguntadas aparte, la pregunta es «¿algún otro medicamento?», como en la ficha.
    health.anticoagulants || health.boneMedicines ? "Otros medicamentos" : "Medicación",
    declaredGroupWords(health.medications, (item) =>
      joined(textOf(item.name), textOf(item.dose), textOf(item.frequency), textOf(item.notes)),
    ),
  )
  add("bloodGroup", "Grupo sanguíneo", health.bloodGroup ?? null)
  const personal = health.personal
  if (typeof personal?.embarazo === "boolean")
    add(
      PREGNANCY_ENTRY_KEY,
      "Embarazo",
      !personal.embarazo
        ? "No"
        : typeof personal.semanasEmbarazo === "number"
          ? `Sí, ${personal.semanasEmbarazo} ${personal.semanasEmbarazo === 1 ? "semana" : "semanas"}`
          : "Sí",
    )
  // El embarazo ya va arriba, con las semanas que dijo ese día: no se recalcula a la fecha de la copia.
  return [...out, ...interviewEntries.filter((entry) => entry.key !== PREGNANCY_ENTRY_KEY)]
}

/** Lo que se sabe de cada clase de medicina, en la copia (lo mismo que dice la atención). */
const MEDICINE_CLASS_WORDS: Record<MedicineClassAnswer["answer"], string> = {
  yes: "toma una",
  saidYes: "dijo que toma una; falta anotar cuál",
  took: "la tomó antes, hoy no",
  no: "no toma",
  unknown: "no sabe",
  skipped: "no respondió",
  unasked: "no se le preguntó",
}
/** El estado de FHIR R4 de cada respuesta de una clase (`MedicationStatement.status`). */
const MEDICINE_CLASS_FHIR: Partial<Record<MedicineClassAnswer["answer"], string>> = {
  saidYes: "active",
  took: "completed",
  no: "not-taken",
  unknown: "unknown",
}

/** La entrevista vigente y, de cada dato, desde qué versión consta igual. */
function interviewOf(
  versions: Array<{ version: number; answers: unknown; createdAt: Date; createdBy: string | null; authorName: string | null }>,
  /**
   * `current`: es la versión vigente (lo que se sabe de un embarazo sin fecha solo vale para ella).
   * `shownDay`: el día que el encabezado ya dice, para no repetirlo en el embarazo.
   */
  entriesOf: (answers: unknown, current: boolean, shownDay: string | null) => InterviewEntry[],
  health: { declarations: HealthDeclaration[]; declared: DeclaredHealthGroup[] },
  /** El día de la clínica de un instante (YYYY-MM-DD). */
  dayOf: (at: Date) => string,
): RecordInterview | null {
  const latest = versions.at(-1)
  // Una versión que entró con una declaración comparte su instante: de ella salen quién lo dijo y
  // cuándo. Sin declaración, la escribió el equipo; la que no tiene autor (lo de antes de guardarse
  // quién fue) se declaró, y no se afirma quién.
  const saidOf = (row: (typeof versions)[number]): RecordSaid => {
    const declaration = health.declarations.find((item) => item.enteredAt.getTime() === row.createdAt.getTime())
    if (declaration) return { kind: "declared", by: declaration.by, at: declaration.at }
    if (row.createdBy === null)
      return { kind: "declared", by: { kind: "unknown", name: null, relation: null }, at: row.createdAt }
    return { kind: "recorded", by: row.authorName, at: row.createdAt }
  }
  const said = latest ? saidOf(latest) : null
  const current = latest && said ? entriesOf(latest.answers, true, dayOf(said.at)) : []
  // Sin ningún dato vigente no hay entrevista que mostrar: un encabezado solo, con quién y cuándo, no dice nada.
  if (!latest || !said || current.length === 0) return null
  const told = versions.map((row) => new Map(entriesOf(row.answers, false, null).map((entry) => [entry.key, entry.value])))
  const unreviewedPregnancy = health.declared.find((group) => group.pregnancy)
  // Lo dijo la misma persona el mismo día que dice el encabezado: la marca queda en «sin revisar»,
  // sin repetir quién ni cuándo (verificador, QA de la entrega 2: Lucero lo leía tres veces).
  const repeatsVersion =
    !!unreviewedPregnancy &&
    said.kind === "declared" &&
    said.by.kind === unreviewedPregnancy.by.kind &&
    said.by.name === unreviewedPregnancy.by.name &&
    !!unreviewedPregnancy.at &&
    dayOf(unreviewedPregnancy.at) === dayOf(said.at)
  return {
    version: latest.version,
    said,
    entries: current.map((entry) => {
      let first = versions.length - 1
      // El embarazo trae su propio día (el que se dijo): no se le busca otro en las versiones.
      if (entry.key !== PREGNANCY_ENTRY_KEY)
        while (first > 0 && told[first - 1]?.get(entry.key) === entry.value) first -= 1
      const from = versions[first]
      return {
        ...entry,
        since: from && from !== latest ? saidOf(from) : null,
        ...(entry.key === PREGNANCY_ENTRY_KEY && unreviewedPregnancy
          ? { unreviewed: { by: unreviewedPregnancy.by, at: unreviewedPregnancy.at, repeatsVersion } }
          : (() => {
              // El corazón, la anestesia, el tabaco, la lactancia y lo de un niño en casa que dijo y nadie
              // revisó (QA de la entrega 6; lo de un niño, dato por dato, revisión final del 15 nov).
              const keys = ENTRY_DECLARED_KEYS[entry.key]
              const group = keys ? health.declared.find((item) => keys.some((key) => item.interview.includes(key))) : undefined
              return group ? { unreviewed: { by: group.by, at: group.at } } : {}
            })()),
      }
    }),
  }
}

/** Todo lo de la persona, de su clínica, en orden cronológico. */
export async function loadPatientRecord(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<PatientRecord> {
  const identity = await requirePatient(tx, orgId, patientId)
  const full = await getPatient(tx, orgId, patientId)
  const byPatient = <T extends { organizationId: unknown; patientId: unknown }>(table: T) =>
    and(eq(table.organizationId as never, orgId), eq(table.patientId as never, patientId))
  const [establishmentRow] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      fiscalDocType: orgProfile.fiscalDocType,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      address: orgProfile.fiscalAddress,
      locale: orgProfile.locale,
      timezone: orgProfile.timezone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const allergies = await tx
    .select()
    .from(patientAllergy)
    .where(and(byPatient(patientAllergy), eq(patientAllergy.isActive, true)))
    .orderBy(asc(patientAllergy.createdAt))
  const removedAllergies = (
    await tx
      .select({ row: patientAllergy, removedByName: user.name })
      .from(patientAllergy)
      .leftJoin(user, eq(user.id, patientAllergy.removedBy))
      .where(and(byPatient(patientAllergy), eq(patientAllergy.isActive, false), isNotNull(patientAllergy.removedAt)))
      .orderBy(asc(patientAllergy.removedAt))
  ).map(({ row, removedByName }) => ({ ...row, removedByName }))
  const conditions = await tx
    .select()
    .from(patientCondition)
    .where(byPatient(patientCondition))
    .orderBy(asc(patientCondition.createdAt))
  const medications = await tx
    .select()
    .from(patientMedication)
    .where(byPatient(patientMedication))
    .orderBy(asc(patientMedication.createdAt))
  const interviewVersions = await tx
    .select({
      version: patientAnamnesis.version,
      answers: patientAnamnesis.answers,
      createdAt: patientAnamnesis.createdAt,
      createdBy: patientAnamnesis.createdBy,
      authorName: user.name,
    })
    .from(patientAnamnesis)
    .leftJoin(user, eq(user.id, patientAnamnesis.createdBy))
    .where(byPatient(patientAnamnesis))
    .orderBy(asc(patientAnamnesis.version))
  const encounters = await tx
    .select()
    .from(encounter)
    .where(byPatient(encounter))
    .orderBy(asc(encounter.startedAt))
  const encounterIds = encounters.map((e) => e.id)
  // Lo anulado también es historia (se corrigió, no se borró): va aparte, con su motivo.
  const allDiagnoses = encounterIds.length
    ? await tx
        .select()
        .from(encounterDiagnosis)
        .where(byPatient(encounterDiagnosis))
        .orderBy(asc(encounterDiagnosis.createdAt))
    : []
  const diagnoses = allDiagnoses.filter((d) => !d.voidedAt)
  // Las notas: las adendas van con su atención («Correcciones después del cierre»); las demás son
  // notas clínicas, de una atención o sueltas (mesa del 18 nov: solo salían las adendas).
  const notes = await tx
    .select({
      id: clinicalNote.id,
      encounterId: clinicalNote.encounterId,
      kind: clinicalNote.kind,
      note: clinicalNote.note,
      authorName: user.name,
      createdAt: clinicalNote.createdAt,
      siteSystem: clinicalNote.siteSystem,
      siteCode: clinicalNote.siteCode,
      siteQualifiers: clinicalNote.siteQualifiers,
    })
    .from(clinicalNote)
    .leftJoin(user, eq(user.id, clinicalNote.authorUserId))
    .where(byPatient(clinicalNote))
    .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id))
  const addenda = notes.filter((n) => n.kind === "adenda" && n.encounterId)
  const allProcedures = encounterIds.length
    ? await tx
        .select()
        .from(encounterProcedure)
        .where(and(eq(encounterProcedure.organizationId, orgId), inArray(encounterProcedure.encounterId, encounterIds)))
        .orderBy(asc(encounterProcedure.createdAt))
    : []
  const procedures = allProcedures.filter((p) => !p.voidedAt)
  const orders = await tx.select().from(clinicalOrder).where(byPatient(clinicalOrder)).orderBy(asc(clinicalOrder.createdAt))
  const leaves = await tx.select().from(medicalLeave).where(byPatient(medicalLeave)).orderBy(asc(medicalLeave.issuedAt))
  const planRows = await listPlanItems(tx, orgId, patientId, undefined, { withoutVoided: true })
  const titles = await diagnosisTitlesOf(tx, [
    ...allDiagnoses.map((d) => ({ system: d.diagnosisSystem, code: d.diagnosisCode })),
    ...allProcedures.map((p) => ({ system: p.diagnosisSystem, code: p.diagnosisCode })),
    ...orders.map((o) => ({ system: o.diagnosisSystem, code: o.diagnosisCode })),
    ...leaves.map((l) => ({ system: l.diagnosisSystem, code: l.diagnosisCode })),
    ...planRows.map((i) => ({ system: i.diagnosisSystem, code: i.diagnosisCode })),
  ])
  const nameOfDiagnosis = (system: string | null, code: string | null) => (code ? namedDiagnosis(titles, system, code) : null)
  const prescriptions = await tx
    .select()
    .from(prescription)
    .where(byPatient(prescription))
    .orderBy(asc(prescription.issuedAt))
  const items = prescriptions.length
    ? await tx
        .select()
        .from(prescriptionItem)
        .where(byPatient(prescriptionItem))
        .orderBy(asc(prescriptionItem.createdAt))
    : []
  const consents = await tx
    .select()
    .from(consentDocument)
    .where(byPatient(consentDocument))
    .orderBy(asc(consentDocument.createdAt))
  // Lo oculto en su portal sí va: es su historia (mesa del 18 nov). Lo retirado se nombra aparte.
  const documents = await tx
    .select()
    .from(patientDocument)
    .where(and(byPatient(patientDocument), isNull(patientDocument.retiredAt)))
    // Por su fecha (la de toma, en una imagen), como en la Historia; sin ella, la de subida.
    .orderBy(asc(sql`coalesce(${patientDocument.capturedAt}, ${patientDocument.createdAt})`), asc(patientDocument.createdAt))
  const retired = await tx
    .select({
      id: patientDocument.id,
      category: patientDocument.category,
      capturedAt: patientDocument.capturedAt,
      createdAt: patientDocument.createdAt,
      retiredAt: patientDocument.retiredAt,
      reason: patientDocument.retireReason,
      retiredBy: user.name,
    })
    .from(patientDocument)
    .leftJoin(user, eq(user.id, patientDocument.retiredBy))
    .where(and(byPatient(patientDocument), isNotNull(patientDocument.retiredAt)))
    .orderBy(asc(patientDocument.retiredAt))
  const studies = documents.length
    ? await tx
        .select({
          documentId: imagingStudy.documentId,
          studyInstanceUid: imagingStudy.studyInstanceUid,
          modality: imagingStudy.modality,
          fileCount: imagingStudy.fileCount,
          completedAt: imagingStudy.completedAt,
        })
        .from(imagingStudy)
        .where(and(eq(imagingStudy.organizationId, orgId), inArray(imagingStudy.documentId, documents.map((d) => d.id))))
    : []
  const seriesRows = studies.length
    ? await tx
        .select({
          documentId: imagingStudyFile.documentId,
          uid: imagingStudyFile.seriesInstanceUid,
          count: sql<number>`count(*)::int`,
        })
        .from(imagingStudyFile)
        .where(and(eq(imagingStudyFile.organizationId, orgId), inArray(imagingStudyFile.documentId, studies.map((s) => s.documentId))))
        .groupBy(imagingStudyFile.documentId, imagingStudyFile.seriesInstanceUid)
    : []
  const appointments = await tx
    .select()
    .from(appointment)
    .where(byPatient(appointment))
    .orderBy(asc(appointment.startsAt))
  // Lo que la persona envió y nadie revisó también es suyo: va marcado «sin revisar», como lo
  // que declaró de su salud (QA de la entrega 2).
  const forms = await loadFormRecords(tx, orgId, patientId, { unreviewed: true })
  const hooks = await productHooks(tx, orgId)
  const productSections = await hooks.recordSections(tx, { orgId, patientId })
  const today = await clinicToday(tx, orgId)
  // Quién dijo cada cosa y qué sigue sin revisar lo decide el servidor, igual que para la ficha. La
  // copia entrega todas sus declaraciones, sin el tope de la pantalla.
  const health = await getPatientHealth(tx, orgId, patientId, { allDeclarations: true })
  // Quién revisó los antecedentes y las alergias, con su nombre, como lo dice la ficha.
  const reviewerIds = [health.reviewedBy, health.allergiesReviewedBy].filter((id): id is string => !!id)
  const reviewers = new Map(
    reviewerIds.length
      ? (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, reviewerIds))).map(
          (row) => [row.id, row.name] as const,
        )
      : [],
  )
  const reviewOf = (at: Date | null, by: string | null) =>
    at ? { at, by: by ? (reviewers.get(by) ?? null) : null } : null
  // Su último «no» a un grupo (las declaraciones vienen de la más nueva a la más antigua).
  const saidNoOf = (topic: HealthTopic) => {
    const last = health.declarations.find((declaration) => {
      const state = declaration.health[topic]?.state
      return state !== undefined && state !== "unanswered"
    })
    return last && last.health[topic]?.state === "none" ? { by: last.by, at: last.at } : null
  }
  // Un embarazo guardado antes, sin fecha, toma la del día en que se anotó ese «sí»: lo calcula la
  // ficha (`getPatientHealth`), y la copia usa el mismo día.
  const legacySaidOn = health.pregnancy?.saidOn ?? null
  const site = hooks.site
  const recordSite = (row: SiteColumns): RecordSite => ({
    siteWords: site.words(row),
    bodySite: site.bodySite(row),
  })
  const timezone = establishmentRow?.timezone || "UTC"
  // El término de la ficha junto a su código («irreversible sintomática» junto a K04.0), con la
  // misma regla que la Historia (`formDiagnosesOf`): el diagnóstico no lo guarda.
  const saidInForms =
    hooks.forms.qualifiers && encounterIds.length
      ? formDiagnosesOf(
          await tx
            .select({
              id: clinicalFormResponse.id,
              encounterId: clinicalFormResponse.encounterId,
              templateSnapshot: clinicalFormResponse.templateSnapshot,
              answers: clinicalFormResponse.answers,
            })
            .from(clinicalFormResponse)
            .where(
              and(
                eq(clinicalFormResponse.organizationId, orgId),
                inArray(clinicalFormResponse.encounterId, encounterIds),
                notInArray(clinicalFormResponse.status, ["descartado"]),
              ),
            ),
          hooks.forms,
        )
      : []
  const qualifierOf = new Map(
    saidInForms.flatMap((said) =>
      said.encounterId && said.qualifier ? [[formDiagnosisKey(said.encounterId, said.code, said.toothNumber), said.qualifier] as const] : [],
    ),
  )
  const looseValue = (row: SiteColumns): number | null => (row.siteSystem === site.system ? site.value(row.siteCode) : null)
  // La próxima cita en pie de cada tratamiento (la que lo lleva), para «Lo que sigue».
  const nextOfItem = new Map<string, Date>()
  if (planRows.length)
    for (const row of await tx
      .select({ planItemId: appointmentPlanItem.planItemId, startsAt: appointment.startsAt })
      .from(appointmentPlanItem)
      .innerJoin(
        appointment,
        and(eq(appointment.organizationId, appointmentPlanItem.organizationId), eq(appointment.id, appointmentPlanItem.appointmentId)),
      )
      .where(
        and(
          eq(appointmentPlanItem.organizationId, orgId),
          inArray(appointmentPlanItem.planItemId, planRows.map((item) => item.id)),
          inArray(appointment.status, ["programada", "confirmada"]),
          gt(appointment.startsAt, new Date()),
        ),
      )
      .orderBy(asc(appointment.startsAt))) {
      if (!nextOfItem.has(row.planItemId)) nextOfItem.set(row.planItemId, row.startsAt)
    }
  const [home] = await tx
    .select({
      line: patient.address,
      city: patient.addressCity,
      district: patient.addressDistrict,
      region: patient.addressRegion,
      postalCode: patient.addressPostalCode,
      country: patient.addressCountry,
      reference: patient.addressReference,
    })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
  const homeText = home ? postalAddressText(await orgClinicalProfile(tx, orgId), home, { reference: home.reference }) : null
  const asaBy = health.asaClassSetBy
    ? ((await tx.select({ name: user.name }).from(user).where(eq(user.id, health.asaClassSetBy)))[0]?.name ?? null)
    : null
  const followUps = await listFollowUps(tx, orgId, patientId)
  const planById = new Map(planRows.map((item) => [item.id, item]))
  // Lo de la entrevista que trajo una declaración, como lo cuenta el producto, con las claves con que entró ese día.
  const saidInterviewOf = (declaration: HealthDeclaration): InterviewEntry[] => {
    const day = clinicDay(declaration.at, timezone)
    return hooks.interview.record(hooks.interview.declared(declaration.health, day), day)
  }
  return {
    generatedAt: new Date(),
    clinic: await loadDocumentClinic(tx, orgId),
    person: {
      patientId,
      patientNumber: identity.patientNumber,
      displayName: identity.displayName,
      givenNames: identity.givenNames ?? null,
      familyName: identity.familyName ?? null,
      docType: identity.docType,
      docNumber: identity.docNumber,
      docCountry: identity.docCountry ?? null,
      birthDate: identity.birthDate ? String(identity.birthDate).slice(0, 10) : null,
      sex: identity.sex ?? null,
      phone: identity.phone ?? null,
      email: identity.email ?? null,
      address: home && homeText ? { ...home, text: homeText } : null,
    },
    contacts: full.contacts
      .filter((c) => c.relationship !== "self")
      .map((c) => ({
        contactId: c.contactId,
        displayName: c.displayName,
        relationship: c.relationship,
        detail: c.relationshipDetail,
        phone: c.phone,
        isEmergency: !!c.isEmergency,
      })),
    asa: health.asaClass ? { value: health.asaClass, by: asaBy, at: health.asaClassSetAt } : null,
    pregnancy: health.pregnancy,
    allergiesSaidUnknown: (() => {
      const said = allergiesSaidUnknownOf({
        reviewState: health.reviewStatus.allergies,
        activeAllergies: allergies.length,
        declarations: health.declarations,
      })
      return said ? { by: said.by, at: said.at } : null
    })(),
    clinicalNotes: notes
      .filter((n) => n.kind !== "adenda")
      .map((n) => ({
        id: n.id,
        encounterId: n.encounterId,
        note: n.note,
        authorName: n.authorName,
        createdAt: n.createdAt,
        siteWords: site.words(n),
      })),
    followUps: followUps.map((f) => ({
      id: f.id,
      title: f.title,
      kind: f.kind,
      status: f.status,
      dueAt: f.dueAt,
      appointmentAt: f.scheduledAt,
      overdue: f.overdue,
      outcome: f.outcome,
      cancelledReason: f.cancelledReason,
      completedAt: f.completedAt,
      cancelledAt: f.cancelledAt,
    })),
    orders: orders.map((o) => ({
      ...o,
      kindWords: ORDER_KIND_WORDS[o.kind] ?? "Orden",
      diagnosisName: nameOfDiagnosis(o.diagnosisSystem, o.diagnosisCode),
    })),
    leaves: leaves.map((l) => ({ ...l, diagnosisName: l.showDiagnosis ? nameOfDiagnosis(l.diagnosisSystem, l.diagnosisCode) : null })),
    retiredDocuments: retired.map((d) => ({
      id: d.id,
      typeWords: FILE_TYPE_WORDS[d.category] ?? "Archivo",
      at: d.capturedAt ?? d.createdAt,
      retiredAt: d.retiredAt as Date,
      reason: d.reason,
      retiredBy: d.retiredBy,
    })),
    imagingStudies: studies
      .filter((s) => s.completedAt)
      .map((s) => ({
        ...s,
        series: seriesRows
          .filter((row) => row.documentId === s.documentId && row.uid)
          .map((row) => ({ uid: row.uid as string, count: row.count })),
      })),
    papers: [],
    missing: [],
    allergies,
    removedAllergies,
    conditions,
    medications,
    today,
    reviews: {
      history: reviewOf(health.reviewedAt, health.reviewedBy),
      allergies: reviewOf(health.allergiesReviewedAt, health.allergiesReviewedBy),
    },
    groups: {
      allergies: { state: health.reviewStatus.allergies, saidNo: saidNoOf("allergies") },
      conditions: { state: health.reviewStatus.conditions, saidNo: saidNoOf("conditions") },
      medications: { state: health.reviewStatus.medications, saidNo: saidNoOf("medications") },
    },
    // Cada producto cuenta su entrevista (odentIA: lo de la boca; latidIA: embarazo y lactancia con fecha).
    declared: health.declared,
    changed: health.changed,
    declarations: health.declarations
      .filter((declaration) => declaration.via !== "formulario")
      .map((declaration) => ({
        at: declaration.at,
        via: declaration.via,
        by: declaration.by,
        reason: declaration.reason,
        entries: declarationEntries(declaration.health, saidInterviewOf(declaration), declaration.reason),
      }))
      .reverse(),
    medicineClasses: (Object.keys(health.medicineClasses) as MedicationClass[]).flatMap((group) => {
      const known = health.medicineClasses[group]
      return known.answer === "yes" ? [] : [{ group, answer: known.answer, said: known.said }]
    }),
    interview: interviewOf(
      interviewVersions,
      (answers, current, shownDay) => hooks.interview.record(answers, today, current ? { legacySaidOn, shownDay } : {}),
      health,
      (at) => clinicDay(at, timezone),
    ),
    familyHistory: health.familyHistory,
    encounters: encounters.map((row) => ({
      row,
      diagnoses: diagnoses
        .filter((d) => d.encounterId === row.id)
        .map((d) => ({
          ...d,
          ...recordSite(d),
          title: titles.get(`${d.diagnosisSystem}|${d.diagnosisCode}`) ?? null,
        })),
      diagnosisLines: encounterDiagnosisLines({
        diagnoses: diagnoses
          .filter((d) => d.encounterId === row.id)
          .map((d) => ({
            system: d.diagnosisSystem,
            code: d.diagnosisCode,
            type: d.diagnosisType,
            status: d.status,
            site: d,
            qualifier: qualifierOf.get(formDiagnosisKey(row.id, d.diagnosisCode, looseValue(d))) ?? null,
          })),
        procedures: procedures
          .filter((p) => p.encounterId === row.id)
          .map((p) => ({ system: p.diagnosisSystem, code: p.diagnosisCode, site: { ...p, siteQualifiers: [] } })),
        titles,
        site,
      }).concat(
        // La nota de un diagnóstico (lo que la ficha escribe debajo) va en su línea.
        diagnoses
          .filter((d) => d.encounterId === row.id && d.note?.trim())
          .map((d) => `${nameOfDiagnosis(d.diagnosisSystem, d.diagnosisCode)}: ${d.note?.trim()}`),
      ),
      voided: [
        ...allDiagnoses
          .filter((d) => d.encounterId === row.id && d.voidedAt)
          .map(
            (d) =>
              `Diagnóstico ${nameOfDiagnosis(d.diagnosisSystem, d.diagnosisCode)}${site.words(d, "short") ? ` · ${site.words(d, "short")}` : ""} · anulado${d.voidReason ? `: ${d.voidReason}` : ""}`,
          ),
        ...allProcedures
          .filter((p) => p.encounterId === row.id && p.voidedAt)
          .map((p) => {
            const where = site.words(p, "short") ? ` · ${site.words(p, "short")}` : ""
            // Marcado después de firmar: «no se hizo», con su motivo (mesa del cierre, 19 nov).
            if (notDoneAfterSigning(p, row)) return `${p.description}${where} · no se hizo: ${p.voidReason?.replace(/^No se hizo: /, "") ?? ""}`
            return `${p.description}${where} · anulado${p.voidReason ? `: ${p.voidReason}` : ""}`
          }),
      ],
      procedures: procedures
        .filter((p) => p.encounterId === row.id)
        .map((p) => ({ ...p, ...recordSite(p) })),
      notDone: allProcedures
        .filter((p) => p.encounterId === row.id && notDoneAfterSigning(p, row))
        .map((p) => ({ ...p, ...recordSite(p) })),
      exam: {
        lines: hooks.examination.recordLines(row.examination),
        observations: hooks.examination.observations(row.examination),
      },
      addenda: addenda
        .filter((a) => a.encounterId === row.id)
        .map((a) => ({ note: a.note, authorName: a.authorName, createdAt: a.createdAt })),
    })),
    productSections,
    planPhases: hooks.planPhases.map((key) => ({ key, words: hooks.phaseWords?.(key) ?? null })),
    // El plan como la ficha (`listPlanItems` con `withoutVoided`): sin lo de una atención anulada,
    // con la decisión de la persona, su camino y sus sesiones; nunca su precio.
    planItems: planRows.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      decision: item.decisionStatus,
      stateWords: planItemStateText(item.status, item.decisionStatus),
      siteWords: site.words(item, "short"),
      bodySite: site.bodySite(item),
      phase: item.phase,
      diagnosisName: item.diagnosisName,
      diagnosisSystem: item.diagnosisSystem,
      diagnosisCode: item.diagnosisCode,
      sessionsDone: item.sessionsDone,
      plannedSessions: item.plannedSessions,
      path: item.path,
      statusReason: item.statusReason,
      waitsFor: item.waitsFor?.title ?? null,
      nextAppointmentAt: nextOfItem.get(item.id) ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    prescriptions: prescriptions.map((row) => ({
      row,
      items: items.filter((i) => i.prescriptionId === row.id),
    })),
    // El consentimiento va con su tratamiento: su pieza es la del tratamiento.
    consents: consents.map((c) => {
      const item = c.planItemId ? planById.get(c.planItemId) : undefined
      return { ...c, siteWords: item ? site.words(item, "short") : null, bodySite: item ? site.bodySite(item) : null }
    }),
    forms,
    documents,
    appointments,
    visitAnswers: await patientVisitAnswers(tx, orgId, patientId),
  }
}

// La copia completa en su ZIP (mesa del 18 nov): vive en su módulo, con el mismo nombre de siempre.
export {
  buildPatientRecordCopy,
  type PatientRecordCopy,
  type PatientRecordSummary,
  patientRecordSummary,
  RECORD_README,
} from "./patient-record-copy.js"

/** Nombre del archivo, sin caracteres que un sistema de archivos rechace. */
export function patientRecordFileName(record: PatientRecord, ext: string): string {
  const name = record.person.displayName.replace(/[\\/:*?"<>|]+/g, " ").trim()
  return `Historia de ${name}.${ext}`
}

function diagnosisText(d: {
  diagnosisSystem: string
  diagnosisCode: string
  title: string | null
}): string {
  const short = isDiagnosisSystem(d.diagnosisSystem)
    ? DIAGNOSIS_SYSTEM_INFO[d.diagnosisSystem].short
    : d.diagnosisSystem
  return `${short} · ${d.diagnosisCode}${d.title ? ` · ${d.title}` : ""}`
}

function siteText(p: RecordSite): string {
  return p.siteWords ? ` · ${p.siteWords}` : ""
}

const ENCOUNTER_WORDS: Record<string, string> = {
  borrador: "en curso",
  finalizada: "cerrada",
  anulada: "anulada",
}
const APPOINTMENT_WORDS: Record<string, string> = {
  programada: "programada",
  confirmada: "confirmada",
  atendida: "atendida",
  no_asistio: "no vino",
  cancelada: "cancelada",
}
const RELATION_WORDS: Record<string, string> = {
  guardian: "representante",
  family: "familiar",
  other: "otra persona",
}

/** Quién firmó la atención y a qué hora; sin colegiatura, su motivo escrito (ADR 0200). */
function encounterSignerWords(row: PatientRecord["encounters"][number]["row"], zone: Zone): string {
  const who = signerWords({ name: row.signerName, title: row.signerTitle, registration: row.signerRegistration }) ?? "el equipo"
  const when = row.endedAt ? ` el ${dayTimeWords(row.endedAt, zone)}` : ""
  const skip = row.registrationSkipReason ? ` · sin colegiatura: ${row.registrationSkipReason}` : ""
  return `${who}${when}${skip}`
}

/**
 * La anestesia que guardó la firma de la atención (`anesthesia_at_signing`), con las palabras del
 * detalle de la atención: para qué, la ASA de entonces y quién la clasificó, la dosis máxima por su
 * peso y los avisos. Para quien sigue atendiendo a un niño o a un cardiópata (QA, 18 nov).
 */
function anesthesiaLines(value: NonNullable<PatientRecord["encounters"][number]["row"]["anesthesiaAtSigning"]>, zone: Zone): string[] {
  const uses = value.uses.length > 1 ? `${value.uses.slice(0, -1).join(", ")} y ${value.uses.at(-1)}` : (value.uses[0] ?? "")
  const asa = value.asaClass ? asaLabel(value.asaClass) : null
  const before =
    value.asaBefore !== undefined && value.asaBefore !== value.asaClass
      ? ` (antes: ${value.asaBefore ? `ASA ${value.asaBefore}` : "sin clasificar"})`
      : ""
  const who = value.asaSetBy && value.asaSetAt ? ` · la clasificó ${value.asaSetBy} el ${dayWords(new Date(value.asaSetAt), zone)}` : ""
  return [
    ...(uses ? [`Para ${uses}`] : []),
    ...(asa ? [`${asa}${before}${who}`] : []),
    ...(value.anesthetic ? [`Anestésico: ${value.anesthetic}`] : []),
    value.dose ?? (value.weightKg === null ? "Sin peso anotado: sin dosis máxima" : `Peso: ${value.weightKg} kg`),
    ...value.warnings,
  ]
}

/** «18 nov 2026, 10:32 · Ana Torres · pieza 46: Control post-obturación…». */
function noteWords(n: PatientRecord["clinicalNotes"][number], zone: Zone): string {
  return `${dayTimeWords(n.createdAt, zone)} · ${n.authorName ?? "el equipo"}${n.siteWords ? ` · ${n.siteWords}` : ""}: ${n.note}`
}

/** Un control con su estado, en palabras: por venir, con cita, hecho o cancelado con su motivo. */
function followUpWords(f: PatientRecord["followUps"][number], zone: Zone): string {
  if (f.status === "programado" && f.appointmentAt) return `${f.title} · con cita el ${dayTimeWords(f.appointmentAt, zone)}`
  if (f.status === "realizado")
    return `${f.title} · hecho${f.completedAt ? ` el ${dayWords(f.completedAt, zone)}` : ""}${f.outcome ? `: ${f.outcome}` : ""}`
  if (f.status === "cancelado")
    return `${f.title} · cancelado${f.cancelledAt ? ` el ${dayWords(f.cancelledAt, zone)}` : ""}${f.cancelledReason ? `: ${f.cancelledReason}` : ""}`
  return `${f.title} · toca el ${dayWords(f.dueAt, zone)}${f.overdue ? " · vencido" : ""}`
}

/** Una orden con su resultado, o «sin resultado»; la anulada, con su motivo. */
function orderWords(o: PatientRecord["orders"][number], zone: Zone, record: Pick<PatientRecord, "documents">): string {
  const head = `${o.kindWords}: ${o.title}${o.recipient ? ` · a ${o.recipient}` : ""}${o.diagnosisName ? ` · por ${o.diagnosisName}` : ""} · pedida el ${dayWords(o.createdAt, zone)}`
  if (o.status === "cancelado")
    return `${head} · anulada${o.cancelledAt ? ` el ${dayWords(o.cancelledAt, zone)}` : ""}${o.cancelReason ? `: ${o.cancelReason}` : ""}`
  if (o.status === "completado") {
    const file = o.resultDocumentId ? record.documents.find((d) => d.id === o.resultDocumentId) : undefined
    return `${head} · resultado${o.resultAt ? ` del ${dayWords(o.resultAt, zone)}` : ""}${o.resultText ? `: ${o.resultText}` : ""}${file ? ` · el informe es «${file.label}», en sus documentos` : ""}`
  }
  return `${head} · sin resultado`
}

function leaveWords(l: PatientRecord["leaves"][number], zone: Zone): string {
  const head = `Descanso médico N.º ${l.leaveNumber} · ${l.days} ${l.days === 1 ? "día" : "días"}, del ${civilDay(l.startsOn)} al ${civilDay(l.endsOn)}${l.diagnosisName ? ` · por ${l.diagnosisName}` : ""}`
  const by = signerWords({ name: l.signerName, title: l.signerTitle, registration: l.signerRegistration })
  const voided = l.status === "anulado" ? ` · anulado${l.cancelledAt ? ` el ${dayWords(l.cancelledAt, zone)}` : ""}${l.cancelReason ? `: ${l.cancelReason}` : ""}` : ""
  return `${head}${by ? ` · lo firmó ${by}` : ""}${voided}`
}

/**
 * Un consentimiento en palabras, con su pieza: lo firmado desde su enlace y sin confirmar se dice
 * así, no como «sin firmar» (es otro estado); lo revocado y lo anulado, con su motivo.
 */
function consentWords(c: PatientRecord["consents"][number], zone: Zone): string {
  const head = `${c.titleSnapshot}${c.siteWords ? ` · ${c.siteWords}` : ""}`
  const print = c.pdfSha256 ? ` · huella ${c.pdfSha256.slice(0, 16)}…` : ""
  const informer = signerWords({ name: c.informerName, title: c.informerTitle, registration: c.informerRegistration })
  if (c.status === "firmado")
    return `${head} · firmado${c.signedAt ? ` el ${dayTimeWords(c.signedAt, zone)}` : ""}${c.signatureMethod === "enlace" ? " desde su enlace" : c.signatureMethod === "papel" ? " en papel" : ""}${c.signerName ? ` por ${c.signerName}` : ""}${informer ? ` · informó ${informer}` : ""}${print}`
  if (c.status === "revocado")
    return `${head} · revocado${c.revokedAt ? ` el ${dayTimeWords(c.revokedAt, zone)}` : ""}${c.revokeReason ? `: ${c.revokeReason}` : ""}${print}`
  if (c.status === "anulado") return `${head} · anulado${c.cancelReason ? `: ${c.cancelReason}` : ""}`
  if (c.personSignedAt)
    return `${head} · lo firmó desde su enlace el ${dayTimeWords(c.personSignedAt, zone)} · falta que el profesional lo confirme con la persona delante`
  return `${head} · le falta la firma`
}

/** «46 · lo piensa · 0 de 2 sesiones»: un tratamiento en una línea, sin precio. */
function planItemWords(item: RecordPlanItem, zone: Zone, state = item.stateWords): string {
  const sessions = showsSession(item.sessionsDone, item.plannedSessions)
    ? ` · ${item.sessionsDone} de ${item.plannedSessions} sesiones`
    : ""
  const why = item.diagnosisName ? ` · por ${item.diagnosisName}` : ""
  const reason =
    item.statusReason && ["suspendido", "cancelado", "reemplazado"].includes(item.status) ? `: «${item.statusReason}»` : ""
  const next = item.nextAppointmentAt ? ` · cita el ${dayTimeWords(item.nextAppointmentAt, zone)}` : ""
  const after = item.waitsFor && item.status !== "realizado" ? ` · va después de ${lowerFirst(item.waitsFor)}` : ""
  return `${item.title}${item.siteWords ? ` · ${item.siteWords}` : ""}${why} · ${lowerFirst(state)}${reason}${sessions}${next}${after}`
}

const OPEN_PLAN_STATUSES = ["pendiente", "programado", "en_curso", "suspendido"]
const LEFT_OUT = (item: RecordPlanItem) =>
  item.decision === "rechazado" || item.decision === "no_elegida" || item.status === "cancelado" || item.status === "reemplazado"

/**
 * El plan como lo lee la ficha y como lo dice el FHIR: cada tratamiento una sola vez, con su propia
 * decisión. Lo que compite en un presupuesto y la persona aún no elige va junto, una vez y fuera de
 * las fases («Por decidir entre dos opciones», como el Plan), como caminos que no se suman. Nada se
 * junta por título ni pieza: la corona de otro presupuesto que «lo piensa» sigue en su fase con su
 * decisión, y dos limpiezas son dos (QA antes de entregar, 18 nov).
 */
function planView(record: Pick<PatientRecord, "planItems">): {
  paths: Array<{ budgetId: string; options: Array<{ position: number; name: string | null; items: Array<{ item: RecordPlanItem; state: string }> }> }>
  items: RecordPlanItem[]
} {
  const open = (item: RecordPlanItem) => OPEN_PLAN_STATUSES.includes(item.status) && !LEFT_OUT(item)
  const competing = record.planItems.filter((item) => open(item) && item.path && !item.path.chosen && item.path.pathCount > 1)
  const paths = [...new Set(competing.map((item) => item.path!.budgetId))].map((budgetId) => {
    const own = competing.filter((item) => item.path!.budgetId === budgetId)
    const positions = [...new Set(own.flatMap((item) => item.path!.positions))].sort((a, b) => a - b)
    return {
      budgetId,
      options: positions.map((position) => {
        const items = own.filter((item) => item.path!.positions.includes(position))
        return {
          position,
          name: items.map((item) => item.path?.name).find((name) => !!name) ?? null,
          items: items.map((item) => ({ item, state: item.stateWords })),
        }
      }),
    }
  })
  return { paths, items: record.planItems.filter((item) => !competing.includes(item)) }
}

/** «Caminos que no se suman (elige uno): Opción A · resina · 46 · por responder — o — Opción B …». */
function pathWords(path: ReturnType<typeof planView>["paths"][number], zone: Zone): string {
  return `Caminos que no se suman, falta que elija uno: ${path.options
    .map(
      (option) =>
        `${String.fromCharCode(64 + option.position)}${option.name ? ` (${option.name})` : ""}: ${option.items.map(({ item, state }) => planItemWords(item, zone, state)).join(" + ")}`,
    )
    .join(" · o · ")}`
}

/** El plan por fases, en su orden, más «No se hará»; cada línea con la decisión de la persona. */
export function planLines(record: PatientRecord, zone: Zone): Array<{ title: string; lines: string[] }> {
  const view = planView(record)
  const groups: Array<{ title: string; lines: string[] }> = []
  // Lo que espera que elija un camino va una sola vez y fuera de las fases, como en el Plan.
  if (view.paths.length)
    groups.push({ title: "Por decidir entre opciones, fuera de las fases hasta que elija", lines: view.paths.map((path) => pathWords(path, zone)) })
  const phases = record.planPhases.length > 1 ? record.planPhases : [{ key: null as string | null, words: null }]
  for (const [index, phase] of phases.entries()) {
    const own = (item: RecordPlanItem) => phase.key === null || item.phase === phase.key || (index === 0 && !record.planPhases.some((p) => p.key === item.phase))
    const lines = view.items.filter((item) => !LEFT_OUT(item) && own(item)).map((item) => planItemWords(item, zone))
    if (lines.length)
      groups.push({ title: phase.key === null ? "Tratamientos" : `Fase ${index + 1}${phase.words ? ` · ${phase.words}` : ""}`, lines })
  }
  const out = view.items.filter(LEFT_OUT).map((item) => planItemWords(item, zone))
  if (out.length) groups.push({ title: "No se hará", lines: out })
  return groups
}

/** La línea de un grupo de antecedentes sin nada anotado: «niega», «no se le preguntó», «no sabe». */
function groupStateLine(record: PatientRecord, topic: HealthTopic, label: string, zone: Zone): string | null {
  const rows = { allergies: record.allergies.length, conditions: record.conditions.length, medications: record.medications.length }[topic]
  if (rows > 0 || record.declared.some((group) => group.saidNo[topic])) return null
  const group = record.groups[topic]
  if (group.state === "none") return `${label}: niega`
  if (group.state !== "unknown") return null
  if (topic === "allergies" && record.allergiesSaidUnknown) {
    const said = record.allergiesSaidUnknown
    return `${label}: ${lowerFirst(saidNoWords(said.by, record.person.sex, "no sabe"))} el ${dayWords(said.at, zone)}`
  }
  // Con el «no» que dijo ella en su declaración: la clínica no lo preguntó, pero ella sí lo dijo.
  if (group.saidNo)
    return `${label}: no se le preguntó en la clínica; ${lowerFirst(saidNoWords(group.saidNo.by, record.person.sex))} el ${dayWords(group.saidNo.at, zone)}`
  return `${label}: no se le preguntó`
}

/** La marca de lo que dijo y nadie revisó, o de lo que «dijo que cambió». */
function rowMark(record: PatientRecord, topic: HealthTopic, id: string, zone: Zone): string | null {
  const changed = changedRowWords(record, topic, id, record.person.sex, zone)
  if (changed) return lowerFirst(changed)
  const group = declaredGroupOf(record, topic, id)
  return group ? unreviewedWords(group, record.person.sex, zone) : null
}

/** «Antes de atenderla», «Antes de atenderlo» o, sin saber su sexo, «Antes de atender a la persona». */
export function beforeCareTitle(sex: string | null): string {
  return sex === "F" ? "Antes de atenderla" : sex === "M" ? "Antes de atenderlo" : "Antes de atender a la persona"
}

/** «La representa», «Lo representa» o «Su representante». */
function representsWords(sex: string | null): string {
  return sex === "F" ? "La representa" : sex === "M" ? "Lo representa" : "Su representante"
}

/**
 * «Antes de atenderla»: alergias con su estado, enfermedades, lo que toma (anticoagulante,
 * antiagregante y medicina para los huesos dichos como tales), ASA, embarazo y quién la representa.
 * Lo mismo que la franja de la ficha, en la primera página (voz clínica, 18 nov).
 */
function beforeCareLines(record: PatientRecord, zone: Zone): string[] {
  const sex = record.person.sex
  const lines: string[] = []
  const withMark = (text: string, mark: string | null) => (mark ? `${text} · ${mark}` : text)
  for (const a of record.allergies) {
    const severity = a.severity && a.severity !== "desconocida" ? ` ${a.severity}` : ""
    lines.push(
      withMark(
        `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"}${severity}: ${a.substance}${a.reaction ? ` · ${a.reaction}` : ""}`,
        rowMark(record, "allergies", a.id, zone),
      ),
    )
  }
  for (const [topic, label] of [
    ["allergies", "Alergias"],
    ["conditions", "Enfermedades"],
    ["medications", "Medicación"],
  ] as const) {
    const state = groupStateLine(record, topic, label, zone)
    if (state) lines.push(state)
  }
  for (const group of record.declared)
    for (const [topic, label] of [
      ["allergies", "Alergias"],
      ["conditions", "Enfermedades"],
      ["medications", "Medicación"],
    ] as const)
      if (group.saidNo[topic])
        lines.push(`${label}: ${saidNoWords(group.by, sex)}${group.at ? ` el ${dayWords(group.at, zone)}` : ""}, sin revisar`)
  for (const c of record.conditions.filter((row) => row.status === "activa"))
    lines.push(withMark(`Enfermedad: ${c.name}`, rowMark(record, "conditions", c.id, zone)))
  for (const m of record.medications.filter((row) => isCurrentMedication(row, record.today))) {
    const alert = medicationAlertWords(m)
    // Lo que «dijo que cambió» no se lee como de hoy: «Antes (anticoagulante): …», como en sus antecedentes.
    const head = record.changed?.medications.includes(m.id)
      ? `Antes${alert.group ? ` (${MEDICATION_CLASSES[alert.group].label.toLocaleLowerCase("es")})` : ""}: ${[m.name, m.dose].filter(Boolean).join(" ")}`
      : alert.label
    lines.push(withMark(`${head}${m.frequency ? ` · ${m.frequency}` : ""}`, rowMark(record, "medications", m.id, zone)))
  }
  for (const item of record.medicineClasses)
    lines.push(`${MEDICATION_CLASSES[item.group].label}: ${MEDICINE_CLASS_WORDS[item.answer]}${item.said ? " · lo dijo la persona" : ""}`)
  if (record.asa)
    lines.push(
      `Riesgo anestésico: ${asaLabel(record.asa.value) ?? `ASA ${record.asa.value}`}${record.asa.by ? ` · la clasificó ${record.asa.by}` : ""}${record.asa.at ? ` el ${dayWords(record.asa.at, zone)}` : ""}`,
    )
  const pregnancy = record.pregnancy
  if (pregnancy)
    lines.push(
      pregnancy.state === "vigente"
        ? `Embarazo${pregnancy.weeksToday !== null ? `: ${pregnancy.weeksToday} semanas hoy` : ""}${pregnancy.saidOn ? ` · lo dijo el ${civilDay(pregnancy.saidOn)}` : ""}`
        : `Embarazo por confirmar${pregnancy.saidOn ? ` · lo dijo el ${civilDay(pregnancy.saidOn)}` : ""}`,
    )
  for (const c of record.contacts.filter((row) => row.relationship === "guardian"))
    lines.push(`${representsWords(sex)}: ${c.displayName}${c.detail ? ` (${c.detail})` : ""}${c.phone ? ` · ${c.phone}` : ""}`)
  return lines
}

/**
 * «Lo que sigue»: lo aceptado por hacer (con sus sesiones y su cita), lo que espera respuesta, los
 * controles por venir, las órdenes sin resultado y los consentimientos que faltan.
 */
function nextStepLines(record: PatientRecord, zone: Zone): string[] {
  const view = planView(record)
  const open = view.items.filter((item) => ["pendiente", "programado", "en_curso"].includes(item.status) && !LEFT_OUT(item))
  return [
    ...open.filter((item) => item.decision === "aceptado").map((item) => planItemWords(item, zone)),
    ...open.filter((item) => item.decision !== "aceptado").map((item) => planItemWords(item, zone)),
    ...view.paths.map((path) => pathWords(path, zone)),
    ...record.followUps.filter((f) => f.status === "pendiente" || f.status === "programado").map((f) => followUpWords(f, zone)),
    ...record.orders.filter((o) => o.status === "solicitado" || o.status === "en_proceso").map((o) => orderWords(o, zone, record)),
    ...record.consents.filter((c) => c.status === "pendiente").map((c) => `Consentimiento: ${consentWords(c, zone)}`),
  ]
}

/**
 * «Lo dijo ella el 13 de noviembre de 2026», «Lo dijo su madre, Carla, el …», «Lo
 * anotó el equipo el …»: quién lo dijo y cuándo, con las palabras de la ficha
 * (`saidWhenWords`). Lo que escribió el equipo en Antecedentes: «Lo registró Ana Torres el …».
 */
function saidWords(said: RecordSaid, sex: string | null, zone: Zone): string {
  const day = dayWords(said.at, zone)
  return said.kind === "declared" ? saidWhenWords(said.by, day, sex) : `Lo registró ${said.by ?? "el equipo"} el ${day}`
}

/** «Lo dijo ella el 13 de noviembre de 2026, sin revisar»: la marca de lo que nadie del equipo revisó. */
function unreviewedWords(said: { by: HealthDeclarant; at: Date | null }, sex: string | null, zone: Zone): string {
  return `${saidWhenWords(said.by, said.at ? dayWords(said.at, zone) : "", sex)}, sin revisar`
}

/**
 * Lo que seguía sin revisar al firmar una atención, como lo guardó la firma (`health_at_signing`;
 * auditor, 15 nov, A2 y 52): la marca de cada declaración y lo que dijo, dato por dato. Lo mismo que
 * «Lo que dijo de su salud al firmar» de la atención firmada.
 */
function healthAtSigningWords(group: HealthAtSigning, sex: string | null, zone: Zone): { mark: string; said: string } {
  return {
    mark: unreviewedWords({ by: group.by, at: group.at ? new Date(group.at) : null }, sex, zone),
    said: group.rows.map((row) => `${row.label}: ${row.value}`).join("; "),
  }
}

/** Lo que acompaña a un dato de la entrevista: que sigue sin revisar, o de qué versión anterior viene. */
/** «Dijo que cambió el 14 nov», de lo vigente que no volvió a nombrar; null si no es de eso. */
function changedRowWords(record: Pick<PatientRecord, "changed">, topic: HealthTopic, id: string, sex: string | null, zone: Zone): string | null {
  const changed = record.changed
  return changed?.[topic].includes(id) ? changedWhenWords(changed.by, dayWords(changed.at, zone), sex) : null
}

function entryNote(entry: RecordInterview["entries"][number], sex: string | null, zone: Zone): string | null {
  if (entry.unreviewed) return entry.unreviewed.repeatsVersion ? "sin revisar" : unreviewedWords(entry.unreviewed, sex, zone)
  return entry.since ? saidWords(entry.since, sex, zone) : null
}

/** De qué declaración sin revisar es una alergia, una enfermedad o una medicina; undefined si ya se revisó o la anotó el equipo. */
function declaredGroupOf(
  record: PatientRecord,
  topic: HealthTopic,
  id: string,
): DeclaredHealthGroup | undefined {
  return record.declared.find((group) => group[topic].includes(id))
}

/**
 * Quién lo afirma, como referencia de FHIR R4 (`asserter`, `informationSource`):
 * la paciente, o quien habló por ella con el nombre y el vínculo que quedaron
 * guardados ese día (no se enlaza a una persona vinculada de hoy: no se deduce
 * quién fue). Lo que anotó el equipo o no dice quién: sin referencia.
 */
function asserterOf(by: HealthDeclarant, patientRef: { reference: string }): Record<string, unknown> | null {
  if (by.kind === "patient") return patientRef
  if (by.kind !== "representative") return null
  const display = [by.name, by.relation ? `(${by.relation})` : null].filter(Boolean).join(" ")
  return display ? { display } : null
}

/**
 * El apartado de cada cosa llenada: lo del equipo es una ficha de consulta y lo de la
 * persona, lo que respondió (los nombres de la Historia).
 */
const FORM_SECTION_WORDS: Record<FormRecord["source"], string> = {
  staff: "Fichas de consulta",
  portal: "Lo que respondió el paciente",
}

/** Por dónde llegó una declaración, como título. */
const DECLARATION_VIA_WORDS: Record<RecordDeclaration["via"], string> = {
  registro: "En su registro",
  enlace: "Desde su enlace",
  formulario: "En un formulario",
}

/** «Se quitó la alergia a Ibuprofeno: era otra cosa (…) · lo quitó Ana Torres el 14 de noviembre de 2026». */
function removedAllergyWords(a: PatientRecord["removedAllergies"][number], zone: Zone): string {
  // Un atajo, en sus palabras; lo escrito, tal cual (auditor, 15 nov, A11: el motivo es libre).
  const why = a.removedReason ? lowerFirst(allergyRemovalReasonWords(a.removedReason)) : null
  const when = a.removedAt ? ` el ${dayWords(a.removedAt, zone)}` : ""
  return `Se quitó la ${a.kind === "intolerancia" ? "intolerancia" : "alergia"} a ${a.substance}${why ? `: ${why}` : ""} · lo quitó ${a.removedByName ?? "el equipo"}${when}`
}

/** «Desde su enlace · corrigió lo que había enviado»: por dónde llegó y, antes de una cita, por qué. */
function declarationTitle(declaration: Pick<RecordDeclaration, "via" | "reason">): string {
  const via = DECLARATION_VIA_WORDS[declaration.via]
  return declaration.reason
    ? `${via} · ${lowerFirst(HEALTH_DECLARATION_REASON_LABELS[declaration.reason])}`
    : via
}

/** «Madre: Diabetes tipo 2 (CIE-10 · E11)». */
function familyWords(row: PatientRecord["familyHistory"][number]): string {
  const who = KINSHIP_LABELS[row.relationship as keyof typeof KINSHIP_LABELS] ?? row.relationship
  const code =
    row.diagnosisSystem && row.diagnosisCode
      ? ` (${diagnosisText({ diagnosisSystem: row.diagnosisSystem, diagnosisCode: row.diagnosisCode, title: null })})`
      : ""
  return `${who}: ${row.condition}${code}${row.notes ? ` · ${row.notes}` : ""}`
}

/**
 * «La prueba se repitió · Motivo: lo confirmó en consulta (Ana Torres, 13 de noviembre de
 * 2026, 15:20)»: la adenda o la corrección con su motivo, si lo dijo, y quién y cuándo.
 */
function addendumWords(addendum: FormRecord["addenda"][number], zone: Zone): string {
  const why = addendum.reason ? ` · Motivo: ${addendum.reason}` : ""
  return `${addendum.text}${why} (${[addendum.authorName, dayTimeWords(addendum.createdAt, zone)].filter(Boolean).join(", ")})`
}

/** «De una atención anulada el 14 de noviembre de 2026 · motivo: …»: la misma marca que la Historia. */
function voidedFormWords(form: FormRecord, zone: Zone): string | null {
  if (!form.voidedAttention) return null
  const why = form.voidedAttention.reason ? ` · motivo: ${form.voidedAttention.reason}` : ""
  return `Se conserva, pero ya no vale: es de una atención anulada el ${dayTimeWords(form.voidedAttention.at, zone)}${why}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Un UUID versión 5 (RFC 9562, con SHA-1): siempre el mismo para el mismo espacio y
 * nombre. Da a un recurso de la copia un id que no choca con el de la copia de otro
 * paciente (la madre de dos hermanos) y un `urn:uuid` válido para lo que no tiene uno.
 */
function uuidV5(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** El id del vínculo de una persona con este paciente (`RelatedPerson`). */
const relatedPersonId = (patientId: string, contactId: string): string => uuidV5(patientId, `RelatedPerson:${contactId}`)

/**
 * Lo que cubrió cada revisión, con quién y cuándo. «Revisar antecedentes» cubre las
 * enfermedades y la medicación, salvo el grupo que quedó «no se le preguntó»; las
 * alergias tienen su propia revisión. Así la copia no dice «Antecedentes revisados»
 * encima de lo que nadie revisó (verificador, QA de la entrega 2).
 */
function reviewScopes(
  record: Pick<PatientRecord, "reviews" | "groups">,
): Array<{ label: string; review: { at: Date; by: string | null }; topics: HealthTopic[] }> {
  const out: Array<{ label: string; review: { at: Date; by: string | null }; topics: HealthTopic[] }> = []
  if (record.reviews.history) {
    const topics = (["conditions", "medications"] as const).filter((topic) => record.groups[topic].state !== "unknown")
    const label =
      topics.length === 2 ? "Enfermedades y medicación revisadas" : topics[0] === "conditions" ? "Enfermedades revisadas" : "Medicación revisada"
    if (topics.length) out.push({ label, review: record.reviews.history, topics: [...topics] })
  }
  if (record.reviews.allergies) out.push({ label: "Alergias revisadas", review: record.reviews.allergies, topics: ["allergies"] })
  return out
}



/** El PDF para leer: todo lo de la persona, en el estilo de sus recetas y consentimientos. */
/** «Lo contó ella el 13 nov., 9:15 a. m., desde su enlace · lo vio Dra. Ana Torres al atender, el …». */
function visitToldWords(told: PatientRecord["visitAnswers"][number], zone: Zone, sex: string | null): string {
  const said = `${saidWhenWords(told.by, dayTimeWords(told.submittedAt, zone), sex)}, desde su ${told.submittedVia === "portal" ? "portal" : "enlace"}`
  // Lo que nadie vio todavía al atender va «sin revisar», con el criterio de lo que declaró (QA final de formularios).
  return told.seen ? `${said} · lo vio ${told.seen.by} al atender, el ${dayTimeWords(told.seen.at, zone)}` : `${said}, sin revisar`
}

/** Lo que contó, pregunta por pregunta, sin lo que no respondió. */
function visitRows(told: PatientRecord["visitAnswers"][number]): Array<[string, string]> {
  return (
    [
      ["Se le dijo que viene a", told.toldPurpose],
      ["A qué viene", told.reason?.trim() || null],
      ["Dolor", visitPainWords(told)],
      ["Algo más", told.more?.trim() || null],
    ] as Array<[string, string | null]>
  ).filter((row): row is [string, string] => !!row[1])
}

/**
 * El PDF para leer. `copyLink`: el enlace para bajar la copia completa, con hasta cuándo sirve
 * (`issueRecordCopyLink`); va en la primera página, en texto y en QR.
 */
export async function renderPatientRecordPdf(
  record: PatientRecord,
  clinic: DocumentClinic,
  options: {
    copyLink?: { url: string; until: Date }
    /**
     * Quién del equipo la descargó (para derivar, para la clínica). Sin él, es la copia que se le
     * entrega a la persona: por su pedido o por su enlace.
     */
    downloadedBy?: string | null
  } = {},
): Promise<Uint8Array> {
  const zone = clinic
  const p = record.person
  const chart = chartNumber(p.patientNumber)
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), {
    title: "Historia clínica",
    docLabel: "Historia clínica",
    patientLabel: `${p.displayName} · ${chart}`,
    // Lo que es: la que baja el equipo no se entregó «a pedido de la persona» (auditor, 18 nov).
    legalNote: options.downloadedBy
      ? `Copia generada por ${options.downloadedBy} el ${dayTimeWords(record.generatedAt, clinic)}.`
      : `Copia entregada por ${clinic.tradeName || "la clínica"} a pedido de la persona.`,
    createdAt: record.generatedAt,
  })
  // El título lleva consigo el comienzo de lo suyo: lo primero de una atención o una ficha pide
  // 50 puntos, y un título solo al pie de una página no dice nada (QA de la entrega 2).
  const section = (title: string) =>
    kit.heading(title, { size: SIZE.h2small, before: 18, after: 5, keep: 60 })
  /**
   * Motivo, Diagnóstico, Examen…: el nombre a un lado y su texto al otro; de una
   * lista, cada elemento en su línea. Una pregunta de un formulario es más larga
   * que «Motivo»: su columna se ensancha con `labelWidth`.
   */
  const dataRows = (
    rows: Array<[string, string | Array<string | Inline[]> | null | undefined]>,
    labelWidth = 98,
  ) => {
    const filled = rows.filter(([, value]) => (Array.isArray(value) ? value.length > 0 : !!value))
    if (filled.length === 0) return
    kit.table({
      columns: [{ label: "", width: labelWidth }, { label: "" }],
      plain: true,
      rowPad: 1.5,
      size: SIZE.table,
      rows: filled.map(([label, value]) => [
        [{ inlines: label, tone: "gray" as const }],
        (Array.isArray(value) ? value : [value as string]).map((inlines) => ({ inlines })),
      ]),
    })
  }
  kit.gap(22)
  kit.titleWithDetails("Historia clínica", [
    { text: chart, strong: true },
    { text: `Copia del ${dayWords(record.generatedAt, zone)}` },
  ])
  kit.gap(16)
  kit.facts(
    [
      { label: "Paciente", value: p.displayName, span: 2, strong: true },
      ...(p.docNumber ? [{ label: p.docType ?? "Documento", value: p.docNumber }] : []),
      ...(p.birthDate ? [{ label: "Nacimiento", value: dayWords(p.birthDate, zone) }] : []),
    ],
    4,
  )
  // Cuándo se armó, con su hora: dos copias del mismo día pueden decir cosas distintas.
  kit.text(`Copia generada el ${dayTimeWords(record.generatedAt, zone)}.`, { size: SIZE.second, tone: "gray" })

  // La primera página: lo que no se puede pasar por alto antes de tocar a la persona y lo que
  // está a medias (mesa del 18 nov). La crónica de atenciones viene después.
  if (options.copyLink) {
    kit.gap(10)
    // Un vínculo que se toca (en el celular el QR está en la misma pantalla) y el QR para otro equipo.
    kit.qrPanel({
      url: options.copyLink.url,
      title: "Su copia completa, con sus imágenes y cada papel",
      link: { text: "Bajar mi copia completa", url: options.copyLink.url },
      body: `Toca «Bajar mi copia completa» o escanea el código desde otro equipo. Se baja con este enlace hasta el ${dayWords(options.copyLink.until, zone)}.`,
    })
  }
  section(beforeCareTitle(p.sex))
  kit.bullets(beforeCareLines(record, zone))
  section("Lo que sigue")
  const next = nextStepLines(record, zone)
  if (next.length) kit.bullets(next)
  else kit.text("Nada pendiente: ningún tratamiento aceptado por hacer, control por venir ni orden sin resultado.")

  section("Datos de contacto")
  kit.text(
    [
      p.sex ? `Sexo: ${SEX_LABELS[p.sex as keyof typeof SEX_LABELS] ?? p.sex}` : null,
      p.phone ? `Teléfono: ${p.phone}` : null,
      p.email ? `Correo: ${p.email}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Sin datos de contacto registrados.",
  )
  if (p.address) kit.text(`Domicilio: ${p.address.text}`)
  if (record.contacts.length)
    kit.bullets(
      record.contacts.map(
        (c) =>
          `${c.displayName} · ${c.detail ?? RELATION_WORDS[c.relationship] ?? c.relationship}${c.isEmergency ? " · contacto de emergencia" : ""}${c.phone ? ` · ${c.phone}` : ""}`,
      ),
    )

  section("Alergias y antecedentes")
  // Lo que dijo la persona y nadie revisó va marcado, con quién lo dijo y cuándo, como en la ficha.
  const markOf = (topic: HealthTopic, id: string): string | null => {
    // Lo vigente que no volvió a nombrar (entrega 10) lleva esa marca, no la de su declaración.
    const changed = changedRowWords(record, topic, id, p.sex, zone)
    if (changed) return changed.replace(/^./, (letter) => letter.toLocaleLowerCase("es"))
    const group = declaredGroupOf(record, topic, id)
    return group ? unreviewedWords(group, p.sex, zone) : null
  }
  // Su «no» a un grupo también es algo que dijo: no es que no se le preguntó, ni el «niega» de un profesional.
  const saidNo = record.declared.flatMap((group) =>
    (
      [
        ["allergies", "Alergias"],
        ["conditions", "Enfermedades"],
        ["medications", "Medicación"],
      ] as const
    )
      .filter(([topic]) => group.saidNo[topic])
      .map(
        ([, label]) =>
          `${label}: ${saidNoWords(group.by, p.sex)}${group.at ? ` el ${dayWords(group.at, zone)}` : ""}, sin revisar`,
      ),
  )
  // Quién revisó qué con ella y cuándo, como lo dice la ficha: lo que ya no lleva «sin revisar» no
  // queda sin dueño, y lo que la revisión no tocó no se lee como revisado (QA de la entrega 2).
  const reviewed = reviewScopes(record).map(
    (scope) => `${scope.label}${scope.review.by ? ` por ${scope.review.by}` : ""} el ${dayWords(scope.review.at, zone)}`,
  )
  if (reviewed.length) kit.text(reviewed.join(" · "), { size: SIZE.second, tone: "gray" })
  // Un grupo sin nada anotado dice cómo quedó, con la regla de la franja de la ficha: «niega», «no
  // sabe» o «no se le preguntó», con el «no» que ella dijo, que no se pierde. Antes, sin una revisión
  // de antecedentes, decía «Sin registros.», que se lee «no tiene» (mesa del 18 nov, C2).
  const groupLines = (
    [
      ["allergies", "Alergias"],
      ["conditions", "Enfermedades"],
      ["medications", "Medicación"],
    ] as const
  ).flatMap(([topic, label]) => groupStateLine(record, topic, label, zone) ?? [])
  if (
    !record.allergies.length &&
    !record.removedAllergies.length &&
    !record.conditions.length &&
    !record.medications.length &&
    !saidNo.length &&
    !groupLines.length
  )
    kit.text("Sin registros.")
  if (saidNo.length) kit.bullets(saidNo)
  if (groupLines.length) kit.bullets(groupLines)
  if (record.allergies.length)
    kit.table({
      columns: [{ label: "" }, { label: "", align: "right" }],
      closed: false,
      size: SIZE.table,
      rows: record.allergies.map((a) => [
        [
          {
            inlines: `${a.kind === "intolerancia" ? "Intolerancia a" : "Alergia a"} ${a.substance}`,
            face: "sansSemi" as const,
          },
          ...(markOf("allergies", a.id)
            ? [{ inlines: markOf("allergies", a.id) as string, tone: "gray" as const, size: SIZE.second }]
            : []),
        ],
        [
          {
            inlines: [a.severity && a.severity !== "desconocida" ? a.severity : null, a.reaction]
              .filter(Boolean)
              .join(" · "),
            tone: "soft" as const,
          },
        ],
      ]),
    })
  // Lo quitado no se borra: sale con quién lo quitó, cuándo y por qué (auditor, A11).
  if (record.removedAllergies.length) kit.bullets(record.removedAllergies.map((a) => removedAllergyWords(a, zone)))
  if (record.conditions.length)
    kit.bullets(
      record.conditions.map(
        (c) =>
          `${record.changed?.conditions.includes(c.id) ? "Antes" : "Antecedente"}: ${c.name} · ${c.status}${c.diagnosisCode ? ` · ${c.diagnosisCode}` : ""}${markOf("conditions", c.id) ? ` · ${markOf("conditions", c.id)}` : ""}`,
      ),
    )
  // La que ya no toma no se lee como vigente: dice hasta cuándo y su nota, como el FHIR
  // (`completed`) y la franja de la ficha, que ya no la muestra (QA de la entrega 2).
  if (record.medications.length)
    kit.bullets(
      record.medications.map((m) => {
        const ended = !isCurrentMedication(m, record.today)
        const until = m.endDate ? ` · hasta el ${civilDay(m.endDate)}` : ""
        const mark = markOf("medications", m.id)
        // La de una clase se dice con su clase, como la ficha: «Anticoagulante: Warfarina 5 mg» (auditor, A15).
        // Lo que no volvió a nombrar al decir que cambió no se lee como lo de hoy (dev H2): «Antes».
        const group = medicationClassOf(m.atcCode)
        const kind = group ? MEDICATION_CLASSES[group].label : null
        const before = record.changed?.medications.includes(m.id)
        const head =
          ended || before
            ? `${ended ? "Ya no lo toma" : "Antes"}${kind ? ` (${kind.toLocaleLowerCase("es")})` : ""}`
            : (kind ?? "Medicamento")
        return `${head}: ${m.name}${m.dose ? ` · ${m.dose}` : ""}${m.frequency ? ` · ${m.frequency}` : ""}${until}${m.notes ? ` · ${m.notes}` : ""}${mark ? ` · ${mark}` : ""}`
      }),
    )

  // «Tus medicinas»: lo que se sabe de las dos que se preguntan aparte, también el «No» y el «No sé».
  if (record.medicineClasses.length)
    kit.bullets(
      record.medicineClasses.map(
        (item) => `${MEDICATION_CLASSES[item.group].label}: ${MEDICINE_CLASS_WORDS[item.answer]}${item.said ? " · lo dijo la persona" : ""}`,
      ),
    )

  section("Entrevista de salud")
  if (!record.interview && !record.familyHistory.length) kit.text("Sin entrevista de salud registrada.")
  if (record.interview) {
    kit.text(`Versión ${record.interview.version} · ${saidWords(record.interview.said, p.sex, zone)}`, {
      size: SIZE.second,
      tone: "gray",
    })
    dataRows(
      record.interview.entries.map((entry) => {
        const note = entryNote(entry, p.sex, zone)
        return [entry.label, [note ? [entry.value, { text: ` · ${note}`, tone: "gray" as const }] : entry.value]]
      }),
      140,
    )
  }
  dataRows([["Antecedentes familiares", record.familyHistory.map(familyWords)]], 140)

  // La declaración original: lo que envió, con su fecha y quién. Lo vigente, que el equipo revisa
  // y corrige, está arriba; esto sigue diciendo lo que se declaró.
  if (record.declarations.length) {
    section(`Lo que declaró de su salud (${record.declarations.length})`)
    kit.text(
      "Tal como llegó. Lo vigente, que el equipo revisa y corrige, está en «Alergias y antecedentes» y en «Entrevista de salud».",
      { size: SIZE.second, tone: "gray" },
    )
    for (const declaration of record.declarations) {
      kit.ensure(40)
      kit.gap(6)
      kit.text(declarationTitle(declaration), { face: "sansBold", size: SIZE.table })
      kit.text(saidWhenWords(declaration.by, dayTimeWords(declaration.at, zone), p.sex), {
        size: SIZE.second,
        tone: "gray",
      })
      dataRows(
        declaration.entries.map((entry) => [entry.label, entry.value]),
        140,
      )
    }
  }

  // Lo que contó antes de cada cita (mesa del 13 nov, entrega 8): tal como lo envió, para qué cita,
  // quién lo contó y por dónde, y quién lo vio al atender.
  if (record.visitAnswers.length) {
    section(`Lo que contó antes de cada cita (${record.visitAnswers.length})`)
    for (const told of record.visitAnswers) {
      kit.ensure(40)
      kit.gap(6)
      kit.text(`Para la cita del ${dayTimeWords(told.appointmentStartsAt, zone)}`, { face: "sansBold", size: SIZE.table })
      kit.text(`${visitToldWords(told, zone, p.sex)}.`, { size: SIZE.second, tone: "gray" })
      dataRows(visitRows(told), 140)
    }
  }

  section(`Atenciones (${record.encounters.length})`)
  if (!record.encounters.length) kit.text("Sin atenciones registradas.")
  for (const { row, diagnosisLines, voided, procedures, exam, addenda } of record.encounters) {
    const vitals = (row.vitals ?? {}) as Record<string, unknown>
    const vitalText = VITAL_SIGNS.filter((v) => typeof vitals[v.key] === "number")
      .map((v) => `${v.label} ${vitals[v.key]} ${v.suffix}`)
      .join(" · ")
    kit.ensure(50)
    kit.gap(5)
    kit.rule()
    kit.gap(7)
    kit.spread(
      {
        text: `${dayTimeWords(row.startedAt, zone)}${row.status === "finalizada" ? "" : ` · ${ENCOUNTER_WORDS[row.status] ?? row.status}`}`,
        face: "sansBold",
        size: SIZE.read,
      },
      { text: row.status === "finalizada" ? "" : (row.signerName ?? ""), size: SIZE.second, tone: "gray" },
      { size: SIZE.read, leading: 1.4 },
    )
    kit.gap(4)
    dataRows([
      ["Motivo de consulta", row.reason],
      // La NTS 139 lo pide en la anamnesis (ADR 0003): sin esta fila no llegaba al papel.
      ["Tiempo de enfermedad", row.illnessDuration],
      ["Relato de la enfermedad", row.presentIllness],
      ["Signos vitales", vitalText],
      ["Examen", exam.lines],
      // Con las líneas de la Historia: el término de la ficha, la pieza y su tipo (mesa del 18 nov).
      ["Diagnóstico", diagnosisLines],
      ["Se hizo", procedures.map((pr) => `${pr.description}${siteText(pr)}`)],
      ["Notas clínicas", record.clinicalNotes.filter((n) => n.encounterId === row.id).map((n) => noteWords(n, zone))],
      ["Anestesia al firmar", row.anesthesiaAtSigning ? anesthesiaLines(row.anesthesiaAtSigning, zone) : null],
      ["Anulado en esta atención", voided],
      // Lo que se anotó en una ficha durante la atención, o lo que respondió para ella; sus
      // respuestas van en su apartado.
      [
        "Fichas",
        record.forms
          .filter((form) => form.encounterId === row.id)
          .map((form) => `${form.title} (ver «${FORM_SECTION_WORDS[form.source]}»)`),
      ],
      // Lo que contó antes de venir a la cita de esta atención (entrega 8); el detalle, en su apartado.
      [
        "Lo que contó antes de venir",
        record.visitAnswers.filter((told) => told.encounterId === row.id).map((told) => visitAnswerLine(told)),
      ],
      // La constancia del aviso del cierre: lo que dijo de su salud y nadie había revisado al firmar.
      [
        "Lo que dijo de su salud al firmar",
        (row.healthAtSigning ?? []).map((group) => {
          const words = healthAtSigningWords(group, p.sex, zone)
          return `${words.mark}: ${words.said}`
        }),
      ],
      ["Evolución", row.evolution],
      ["Plan", row.indications],
      ["Anulada", row.status === "anulada" ? row.voidReason : null],
      // Con el nombre de la pantalla: «Correcciones después del cierre» (QA de la entrega 2).
      [
        "Correcciones después del cierre",
        addenda.map((a) => `${a.note} (${[a.authorName, dayTimeWords(a.createdAt, zone)].filter(Boolean).join(", ")})`),
      ],
      // Quién firmó, con su título, su colegiatura y la hora (NTS 139: firma y sello); la que sigue
      // en curso dice que puede cambiar: quien la recibe no puede preguntarle a nadie.
      ["Firmó", row.status === "finalizada" ? encounterSignerWords(row, zone) : null],
      ["Sin firmar", row.status === "borrador" ? "Sigue en curso: lo que dice puede cambiar." : null],
    ])
  }

  // Las notas que no son de una atención.
  const looseNotes = record.clinicalNotes.filter((n) => !n.encounterId)
  if (looseNotes.length) {
    section(`Notas clínicas (${looseNotes.length})`)
    kit.bullets(looseNotes.map((n) => noteWords(n, zone)))
  }

  for (const product of record.productSections) {
    section(product.title)
    if (!product.lines.length && !product.blocks?.length) kit.text(product.empty)
    else if (product.lines.length) kit.bullets(product.lines)
    for (const block of product.blocks ?? []) {
      kit.ensure(60)
      kit.gap(6)
      kit.text(block.title, { face: "sansBold", size: SIZE.table })
      for (const line of block.lines) kit.text(line, { size: SIZE.second, tone: "gray" })
      if (block.table && block.table.rows.length) {
        kit.gap(3)
        kit.table({
          columns: block.table.columns.map((label, index) => ({ label, ...(index === 0 ? { width: 36 } : {}) })),
          size: SIZE.second,
          rows: block.table.rows.map((cells) => cells.map((cell) => [{ inlines: cell }])),
        })
      }
    }
  }

  section("Plan de tratamiento")
  const plan = planLines(record, zone)
  if (!plan.length) kit.text("Sin tratamientos en el plan.")
  for (const group of plan) {
    kit.subheading(group.title)
    kit.bullets(group.lines)
  }

  section("Controles")
  if (!record.followUps.length) kit.text("Sin controles.")
  else kit.bullets(record.followUps.map((f) => followUpWords(f, zone)))

  section("Órdenes")
  if (!record.orders.length) kit.text("Sin órdenes.")
  else kit.bullets(record.orders.map((o) => orderWords(o, zone, record)))

  section("Recetas")
  if (!record.prescriptions.length) kit.text("Sin recetas.")
  for (const { row, items } of record.prescriptions) {
    // La anulada dice su motivo: la de Rosa se anuló por su alergia a la penicilina (C1).
    kit.text(
      `Receta N.º ${row.prescriptionNumber} · ${dayTimeWords(row.issuedAt, zone)}${row.status === "anulada" ? ` · anulada${row.cancelledAt ? ` el ${dayWords(row.cancelledAt, zone)}` : ""}${row.cancelReason ? `: ${row.cancelReason}` : ""}` : ""}`,
      {
        face: "sansSemi",
      },
    )
    const by = signerWords({ name: row.prescriberName, title: row.prescriberTitle, registration: row.prescriberRegistration })
    if (by) kit.text(`La firmó ${by}`, { size: SIZE.second, tone: "gray" })
    kit.bullets(
      items.map(
        (i) =>
          `${i.medicationName}${i.strength ? ` ${i.strength}` : ""}${i.dose ? ` · ${i.dose}` : ""}${i.frequency ? ` · ${i.frequency}` : ""}${i.duration ? ` · ${i.duration}` : ""}`,
      ),
    )
  }

  if (record.leaves.length) {
    section("Descansos médicos")
    kit.bullets(record.leaves.map((l) => leaveWords(l, zone)))
  }

  section("Consentimientos")
  if (!record.consents.length) kit.text("Sin consentimientos.")
  else kit.bullets(record.consents.map((c) => consentWords(c, zone)))

  // Cada papel emitido va en su PDF, el mismo que se envía y se imprime (mesa del 18 nov).
  // El odontograma de hoy no se emitió ni se entregó: va aparte, con su nombre (auditor, 18 nov).
  const emitted = record.papers.filter((paper) => !UNISSUED_PAPER_KINDS.includes(paper.kind))
  const drawn = record.papers.filter((paper) => UNISSUED_PAPER_KINDS.includes(paper.kind))
  const paperLine = (paper: RecordPaperEntry) =>
    `${paper.label} · ${dayWords(paper.at, zone)}${paper.mark ? ` · ${paper.mark}` : ""}${paper.signer ? ` · ${paper.signer}` : ""}`
  if (record.papers.length) {
    section(`Papeles emitidos (${emitted.length})`)
    kit.text(
      options.copyLink
        ? "Cada uno va en su PDF, en la copia completa que se baja con el enlace de la primera página."
        : "Cada uno va en su PDF, en la carpeta «papeles» de esta copia.",
      { size: SIZE.second, tone: "gray" },
    )
    if (emitted.length) kit.bullets(emitted.map(paperLine))
    if (drawn.length) {
      kit.subheading("Dibujado al armar esta copia, sin firmar")
      kit.bullets(drawn.map(paperLine))
    }
  }

  // Las fichas del equipo y lo que respondió la persona, cada uno con su nombre, como en la Historia.
  for (const source of ["staff", "portal"] as const) {
    const forms = record.forms.filter((form) => form.source === source)
    section(`${FORM_SECTION_WORDS[source]} (${forms.length})`)
    if (!forms.length)
      kit.text(source === "staff" ? "Sin fichas de consulta finalizadas." : "No respondió ningún cuestionario.")
    for (const form of forms) {
      kit.ensure(50)
      kit.gap(5)
      kit.rule()
      kit.gap(7)
      kit.text(`${form.title} · versión ${form.version}`, { face: "sansBold", size: SIZE.read })
      const visit = record.encounters.find((entry) => entry.row.id === form.encounterId)
      kit.text(
        `${form.byWords}${visit ? ` · en la atención del ${dayTimeWords(visit.row.startedAt, zone)}` : ""}`,
        { size: SIZE.second, tone: "gray" },
      )
      // De una atención anulada: se conserva, con la misma marca que la Historia (QA de la entrega 2).
      const voided = voidedFormWords(form, zone)
      if (voided) kit.text(voided, { face: "sansSemi", size: SIZE.second })
      for (const group of form.sections) {
        if (group.title) kit.subheading(group.title)
        dataRows(
          // Lo que dejó sin contestar la persona se dice como en su revisión: «No respondió».
          // Lo que propuso Clío y confirmó una persona lo dice, como en la Historia (entrega 11, C8); si la
          // llenó más de una persona, quién escribió cada respuesta (QA final de formularios, H10).
          group.items.map((item) => [
            item.label,
            `${item.words ?? (source === "portal" ? "No respondió" : "Sin respuesta")}${
              item.clio ? ` (${item.clio})` : item.writtenBy ? ` (lo escribió ${item.writtenBy})` : ""
            }`,
          ]),
          190,
        )
      }
      // Lo que el equipo agregó no cambia las respuestas: va aparte, con quién, cuándo y su motivo. En
      // lo que envió la persona se llama «Correcciones» y puede ser anterior a la revisión.
      if (form.addenda.length) {
        kit.subheading(form.addendaTitle)
        kit.bullets(form.addenda.map((addendum) => addendumWords(addendum, zone)))
      }
    }
  }

  section("Imágenes y documentos")
  if (!record.documents.length) kit.text("Sin imágenes ni documentos.")
  else {
    // Lo que tiene en la mano quien lee: el PDF solo (con el enlace) o la copia completa.
    kit.text(
      options.copyLink
        ? "Los archivos van en la copia completa, que se baja con el enlace de la primera página."
        : "Los archivos van en la carpeta «documentos» de esta copia.",
      { size: SIZE.second, tone: "gray" },
    )
    kit.bullets(
      record.documents.map((d) => `${d.label} · ${documentDateWords(d, zone)}`),
    )
  }
  // Lo retirado se nombra con su tipo, su fecha y su motivo, sin el archivo ni su nombre: el
  // nombre puede ser el de otra persona (auditor, 18 nov).
  if (record.retiredDocuments.length) {
    kit.subheading("Retirado de su ficha")
    kit.bullets(
      record.retiredDocuments.map(
        (d) =>
          `${d.typeWords} del ${dayWords(d.at, zone)} · retirado el ${dayWords(d.retiredAt, zone)}${d.retiredBy ? ` por ${d.retiredBy}` : ""}${d.reason ? `: ${d.reason}` : ""}`,
      ),
    )
  }
  if (record.missing.length) {
    kit.subheading("No se pudo incluir")
    kit.bullets(record.missing)
  }

  section("Citas")
  if (!record.appointments.length) kit.text("Sin citas.")
  else
    kit.bullets(
      record.appointments.map(
        (a) =>
          `${dayTimeWords(a.startsAt, zone)} · ${a.serviceName ?? a.reason ?? "Cita"} · ${APPOINTMENT_WORDS[a.status] ?? a.status}`,
      ),
    )
  return kit.finish()
}

type Resource = Record<string, unknown> & { resourceType: string; id: string }

/** El espacio de los UUID v5 de lo que no es de un paciente (la clínica, quien firmó): siempre el mismo. */
const FHIR_ID_NAMESPACE = "3f6b8c1e-2d4a-5b7c-9e0f-1a2b3c4d5e6f"
const FHIR_LIST_EMPTY_REASON_SYSTEM = "http://terminology.hl7.org/CodeSystem/list-empty-reason"
const FHIR_TOOTH_SYSTEM = "http://terminology.hl7.org/CodeSystem/ex-tooth"
const FHIR_DICOM_MODALITY_SYSTEM = "http://dicom.nema.org/resources/ontology/DCM"

/**
 * La criticidad de una alergia (R4 `AllergyIntolerance.criticality`, 0..1): la que anotó la ficha.
 * Sin ella no va: no se deduce de la severidad de la reacción (no se inventa un dato).
 */
function allergyCriticality(a: { criticality: string | null }): { criticality?: string } {
  const code = fhirCode(ALLERGY_CRITICALITY_FHIR, a.criticality)
  return code ? { criticality: code } : {}
}

/**
 * Las referencias del paquete, resueltas dentro de él (R4, Bundle, «Resolving references in
 * Bundles»): con `fullUrl` `urn:uuid:…`, una referencia relativa `Patient/<id>` no se resuelve; se
 * escribe el `fullUrl` del recurso. La que no está en el paquete (lo que no viaja en la copia) queda
 * solo con su `display`, sin `reference`: no apunta a nada que no exista. Las referencias a lo
 * contenido (`#cuestionario`) quedan como están.
 */
function resolveBundleReferences(value: unknown, fullUrlOf: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveBundleReferences(item, fullUrlOf))
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "reference" && typeof inner === "string" && !inner.startsWith("#") && !inner.startsWith("urn:")) {
      const resolved = fullUrlOf.get(inner)
      if (resolved) out.reference = resolved
      continue
    }
    out[key] = key === "contained" ? inner : resolveBundleReferences(inner, fullUrlOf)
  }
  // Una referencia que se cayó sin `display` queda vacía: se dice qué era.
  if ("reference" in (value as Record<string, unknown>) && !("reference" in out) && !("display" in out)) out.display = "No va en esta copia"
  return out
}

/** Una pregunta con lo respondido, para el `Questionnaire` contenido y su `QuestionnaireResponse`. */
interface AskedItem {
  linkId: string
  text: string
  /** `Questionnaire.item.type` de FHIR R4. */
  type: string
  /** Admite varias respuestas. */
  repeats?: boolean
  options?: string[] | null
  /** Vacío si quedó sin responder: la pregunta consta, sin respuesta. */
  answers: Array<Record<string, unknown>>
  /** Quién dio esta respuesta, si no es quien llenó todo (`questionnaireresponse-author` de R4). */
  author?: Record<string, unknown> | null
}

/** La extensión de R4 para decir quién dio una respuesta en particular (`QuestionnaireResponse.item`). */
const FHIR_ITEM_AUTHOR_EXTENSION = "http://hl7.org/fhir/StructureDefinition/questionnaireresponse-author"
const CLIO_NAME = AGENT_NAMES.asistente_clinico

const xhtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * Unas preguntas respondidas como `QuestionnaireResponse` de FHIR R4. El cuestionario
 * va contenido (`contained`), con su título y su versión como quedaron al responder:
 * la clínica no publica sus plantillas en ninguna dirección. Lo que las respuestas
 * no dicen (quién y cuándo, las adendas) viaja en el texto del recurso, que por eso
 * es `additional`.
 */
function questionnaireResponse(input: {
  id: string
  title: string
  /** La versión de lo que se respondió; una declaración no tiene. */
  version?: number
  authored: Date
  patientRef: { reference: string }
  encounterId?: string | null
  /** Quien anotó las respuestas. */
  author?: Record<string, unknown> | null
  /** Quien las dio, si las respondió la persona. */
  source?: Record<string, unknown> | null
  groups: Array<{ linkId: string; text: string; items: AskedItem[] }>
  notes: string[]
  /**
   * `QuestionnaireResponse.status` de R4: `completed` por omisión; `amended` si se le
   * agregó algo después (una adenda, una corrección) y `entered-in-error` si era de
   * una atención anulada.
   */
  status?: "completed" | "amended" | "entered-in-error"
}): Resource {
  const lines = [input.version === undefined ? input.title : `${input.title} · versión ${input.version}`, ...input.notes]
  // FHIR no admite textos vacíos: una sección sin título va sin `text`.
  const labelOf = (group: { linkId: string; text: string }) => ({
    linkId: group.linkId,
    ...(group.text ? { text: group.text } : {}),
  })
  return {
    resourceType: "QuestionnaireResponse",
    id: input.id,
    text: {
      status: "additional",
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${lines.map((line) => `<p>${xhtml(line)}</p>`).join("")}</div>`,
    },
    contained: [
      {
        resourceType: "Questionnaire",
        id: "cuestionario",
        title: input.title,
        ...(input.version === undefined ? {} : { version: String(input.version) }),
        // La plantilla pudo archivarse después: aquí solo consta la versión que se respondió.
        status: "unknown",
        item: input.groups.map((group) => ({
          ...labelOf(group),
          type: "group",
          item: group.items.map((item) => ({
            linkId: item.linkId,
            text: item.text,
            type: item.type,
            ...(item.repeats ? { repeats: true } : {}),
            ...(item.options?.length
              ? { answerOption: item.options.map((valueString) => ({ valueString })) }
              : {}),
          })),
        })),
      },
    ],
    questionnaire: "#cuestionario",
    status: input.status ?? "completed",
    subject: input.patientRef,
    ...(input.encounterId ? { encounter: { reference: `Encounter/${input.encounterId}` } } : {}),
    authored: input.authored.toISOString(),
    ...(input.author ? { author: input.author } : {}),
    ...(input.source ? { source: input.source } : {}),
    item: input.groups.map((group) => ({
      ...labelOf(group),
      item: group.items.map((item) => ({
        ...(item.author ? { extension: [{ url: FHIR_ITEM_AUTHOR_EXTENSION, valueReference: item.author }] } : {}),
        linkId: item.linkId,
        text: item.text,
        ...(item.answers.length ? { answer: item.answers } : {}),
      })),
    })),
  }
}

/** La respuesta de una pregunta como `answer` de FHIR R4, según su tipo (`FORM_FIELD_TYPE_FHIR`). */
function formAnswers(item: FormRecordItem, exported: ReadonlySet<string>): Array<Record<string, unknown>> {
  if (item.words === null) return []
  switch (item.type) {
    case "booleano":
      return [{ valueBoolean: item.value }]
    case "numero":
      return [{ valueDecimal: item.value }]
    case "escala":
      return [{ valueInteger: item.value }]
    case "fecha":
      return [{ valueDate: item.value }]
    case "opcion_multiple":
      // Las opciones de la clínica no tienen código: cada una va como texto.
      return (item.value as string[]).map((valueString) => ({ valueString }))
    case "pieza":
      // El sitio como lo dice el producto, igual que el `bodySite` de un diagnóstico (odentIA: «Pieza 46 (FDI)»).
      return [{ valueString: item.bodySite?.text ?? item.words }]
    case "adjunto":
      // El archivo va en el ZIP si sigue vigente; uno retirado solo se nombra.
      return [
        {
          valueReference: {
            ...(exported.has(item.value as string) ? { reference: `DocumentReference/${item.value}` } : {}),
            display: item.words,
          },
        },
      ]
    default:
      // Lo escrito, la opción elegida y la firma (quién firmó).
      return [{ valueString: item.words }]
  }
}

/**
 * El paquete HL7 FHIR R4 (`Bundle` de tipo `collection`) con lo de la persona.
 * Los códigos propios se traducen con las equivalencias de `@odentia/clinical`;
 * lo que no tiene equivalencia segura va como texto.
 */
export function patientRecordFhirBundle(record: PatientRecord): Record<string, unknown> {
  const p = record.person
  // Las referencias se escriben `Tipo/id` mientras se arma y al final se resuelven dentro del
  // paquete (`resolveBundleReferences`): R4, Bundle «Resolving references in Bundles».
  const patientRef = { reference: `Patient/${p.patientId}` }
  const resources: Resource[] = []
  const docCode = hl7DocumentTypeCode(p.docType, p.docCountry)
  // La clínica y quienes firmaron, como recursos del paquete (R4 Organization y Practitioner): el
  // sistema que lo carga sabe quién atendió y a quién llamar.
  const organizationId = uuidV5(FHIR_ID_NAMESPACE, `Organization:${record.clinic.fiscalDocNumber ?? record.clinic.tradeName}`)
  const organizationRef = { reference: `Organization/${organizationId}` }
  resources.push({
    resourceType: "Organization",
    id: organizationId,
    ...(record.clinic.fiscalDocNumber
      ? {
          identifier: [
            {
              // v2-0203 «TAX»: el número de contribuyente (en el Perú, el RUC). Sin una dirección
              // inventada para la autoridad tributaria: el tipo, el valor y el texto.
              type: { coding: [{ system: HL7_IDENTIFIER_TYPE_SYSTEM, code: "TAX" }], text: record.clinic.fiscalDocType ?? "Contribuyente" },
              value: record.clinic.fiscalDocNumber,
            },
          ],
        }
      : {}),
    active: true,
    name: record.clinic.tradeName || record.clinic.legalName || "Clínica",
    ...(record.clinic.legalName && record.clinic.legalName !== record.clinic.tradeName ? { alias: [record.clinic.legalName] } : {}),
    ...(record.clinic.phone ? { telecom: [{ system: "phone", value: record.clinic.phone }] } : {}),
    ...(record.clinic.address ? { address: [{ text: record.clinic.address }] } : {}),
  })
  const practitioners = new Map<string, string>()
  /** El `Practitioner` de quien firmó, con su colegiatura (v2-0203 «LN») y su título; null sin nombre. */
  const practitionerRef = (s: { name: string | null; title: string | null; registration: string | null }) => {
    const name = s.name?.trim()
    if (!name) return null
    const key = `${name}|${s.registration ?? ""}`
    let id = practitioners.get(key)
    if (!id) {
      id = uuidV5(FHIR_ID_NAMESPACE, `Practitioner:${key}`)
      practitioners.set(key, id)
      resources.push({
        resourceType: "Practitioner",
        id,
        ...(s.registration?.trim()
          ? {
              identifier: [
                {
                  type: { coding: [{ system: HL7_IDENTIFIER_TYPE_SYSTEM, code: "LN" }], text: "Colegiatura" },
                  value: s.registration.trim(),
                },
              ],
            }
          : {}),
        name: [{ text: name }],
        ...(s.title?.trim() ? { qualification: [{ code: { text: s.title.trim() } }] } : {}),
      })
    }
    return { reference: `Practitioner/${id}`, display: name }
  }
  const address = p.address
  resources.push({
    resourceType: "Patient",
    id: p.patientId,
    identifier: [
      {
        use: "usual",
        type: { text: "Historia clínica" },
        value: String(p.patientNumber).padStart(6, "0"),
      },
      ...(p.docNumber
        ? [
            {
              use: "official",
              type: docCode
                ? {
                    coding: [{ system: HL7_IDENTIFIER_TYPE_SYSTEM, code: docCode }],
                    text: p.docType,
                  }
                : { text: p.docType },
              value: p.docNumber,
            },
          ]
        : []),
    ],
    name: [
      {
        text: p.displayName,
        ...(p.familyName ? { family: p.familyName } : {}),
        ...(p.givenNames ? { given: p.givenNames.split(/\s+/).filter(Boolean) } : {}),
      },
    ],
    ...(p.sex ? { gender: fhirCode(SEX_TO_FHIR_GENDER, p.sex) ?? "unknown" } : {}),
    ...(p.birthDate ? { birthDate: p.birthDate } : {}),
    ...(p.phone || p.email
      ? {
          telecom: [
            ...(p.phone ? [{ system: "phone", value: p.phone }] : []),
            ...(p.email ? [{ system: "email", value: p.email }] : []),
          ],
        }
      : {}),
    // El domicilio: la ficha lo guarda ya en la forma de FHIR Address (ADR 0077).
    ...(address
      ? {
          address: [
            {
              use: "home",
              text: address.text,
              ...(address.line ? { line: [address.line] } : {}),
              ...(address.city ? { city: address.city } : {}),
              ...(address.district ? { district: address.district } : {}),
              ...(address.region ? { state: address.region } : {}),
              ...(address.postalCode ? { postalCode: address.postalCode } : {}),
              ...(address.country ? { country: address.country } : {}),
            },
          ],
        }
      : {}),
    managingOrganization: organizationRef,
  })
  for (const c of record.contacts)
    resources.push({
      resourceType: "RelatedPerson",
      // `RelatedPerson` es el vínculo con este paciente, no la persona: la madre de dos hermanos
      // es una en cada copia, y con su id de contacto las dos chocaban al cargarlas en otro
      // sistema (revisor, QA de la entrega 2). Un UUID v5 del paciente y el contacto: siempre el
      // mismo para este vínculo y en los 64 caracteres de un id de FHIR.
      id: relatedPersonId(p.patientId, c.contactId),
      patient: patientRef,
      name: [{ text: c.displayName }],
      relationship: [{ text: c.detail ?? c.relationship }],
      ...(c.phone ? { telecom: [{ system: "phone", value: c.phone }] } : {}),
    })
  // Lo que dijo la persona y nadie revisó: quién lo afirma, en el campo de R4 para eso, y una nota
  // con la marca de la ficha («Lo dijo ella el …, sin revisar»).
  const statedBy = (
    topic: HealthTopic,
    id: string,
    field: "asserter" | "informationSource",
  ): Record<string, unknown> => {
    const changed = changedRowWords(record, topic, id, p.sex, record.clinic)
    const group = changed && record.changed ? record.changed : declaredGroupOf(record, topic, id)
    if (!group) return {}
    const who = asserterOf(group.by, patientRef)
    return { ...(who ? { [field]: who } : {}), note: [{ text: changed ?? unreviewedWords(group, p.sex, record.clinic) }] }
  }
  const allergyRows = [
    ...record.allergies.map((a) => ({ a, removed: null })),
    ...record.removedAllergies.map((a) => ({ a, removed: a })),
  ]
  for (const { a, removed } of allergyRows) {
    const category = fhirCode(ALLERGY_CATEGORY_FHIR, a.category)
    const severity = fhirCode(ALLERGY_SEVERITY_FHIR, a.severity)
    // La que se quitó, como lo dice su motivo (auditor, A11): resuelta, refutada o un error, con una
    // nota de quién la quitó y por qué. Lo que sigue sin revisar es solo de las que están en pie.
    const removal = removed ? (ALLERGY_REMOVAL_FHIR[removed.removedReason as AllergyRemovalReason] ?? null) : null
    const clinicalStatus = !removed ? "active" : removal ? removal.clinicalStatus : "inactive"
    const stated = removed ? { note: [{ text: removedAllergyWords(removed, record.clinic) }] } : statedBy("allergies", a.id, "asserter")
    resources.push({
      resourceType: "AllergyIntolerance",
      id: a.id,
      patient: patientRef,
      ...(clinicalStatus ? { clinicalStatus: { coding: [{ system: FHIR_ALLERGY_CLINICAL_SYSTEM, code: clinicalStatus }] } } : {}),
      verificationStatus: {
        coding: [
          {
            system: FHIR_ALLERGY_VERIFICATION_SYSTEM,
            code: removal?.verificationStatus ?? fhirCode(ALLERGY_VERIFICATION_FHIR, a.verification) ?? "unconfirmed",
          },
        ],
      },
      type: fhirCode(ALLERGY_TYPE_FHIR, a.kind) ?? "allergy",
      ...(category ? { category: [category] } : {}),
      ...allergyCriticality(a),
      // La sustancia con su código ATC si es de la lista (`ALLERGENS`); lo de la lista propia y lo
      // escrito sin codificar va como texto: no se inventa un sistema.
      code: {
        ...(a.substanceSystem === "atc" && a.substanceCode ? { coding: [{ system: FHIR_ATC_SYSTEM, code: a.substanceCode }] } : {}),
        text: a.substance,
      },
      ...stated,
      ...(a.reaction || severity
        ? {
            reaction: [
              {
                manifestation: [{ text: a.reaction ?? "Reacción no descrita" }],
                ...(severity ? { severity } : {}),
              },
            ],
          }
        : {}),
    })
  }
  // Lo que nadie preguntó (o lo que niega) no es un recurso «sin alergias»: en R4 es una `List`
  // vacía con su motivo (`emptyReason`, list-empty-reason: `notasked`, «no se le preguntó»;
  // `nilknown`, «niega»), como lo dice la ficha. Así el sistema que la recibe no lee «no tiene».
  for (const [topic, title, loinc] of [
    ["allergies", "Alergias", { code: "48765-2", display: "Allergies and adverse reactions Document" }],
    ["conditions", "Enfermedades", { code: "11348-0", display: "History of Past illness Narrative" }],
    ["medications", "Medicación", { code: "10160-0", display: "History of Medication use Narrative" }],
  ] as const) {
    const line = groupStateLine(record, topic, title, record.clinic)
    const state = record.groups[topic].state
    if (!line || (state !== "unknown" && state !== "none")) continue
    // «No sabe»: se le preguntó y no lo sabe (`unavailable`, la información no está disponible).
    const reason = state === "none" ? "nilknown" : topic === "allergies" && record.allergiesSaidUnknown ? "unavailable" : "notasked"
    resources.push({
      resourceType: "List",
      id: uuidV5(p.patientId, `List:${topic}`),
      status: "current",
      mode: "snapshot",
      title,
      code: { coding: [{ system: FHIR_LOINC_SYSTEM, ...loinc }], text: title },
      subject: patientRef,
      date: record.generatedAt.toISOString(),
      note: [{ text: line }],
      emptyReason: { coding: [{ system: FHIR_LIST_EMPTY_REASON_SYSTEM, code: reason }], text: line },
    })
  }
  for (const c of record.conditions)
    resources.push({
      resourceType: "Condition",
      id: c.id,
      subject: patientRef,
      clinicalStatus: {
        coding: [
          {
            system: FHIR_CONDITION_CLINICAL_SYSTEM,
            code: fhirCode(CONDITION_CLINICAL_STATUS_FHIR, c.status) ?? "active",
          },
        ],
      },
      // Lo que dijo y nadie revisó no está confirmado, como su alergia (QA de la entrega 2).
      ...(declaredGroupOf(record, "conditions", c.id) || record.changed?.conditions.includes(c.id)
        ? { verificationStatus: { coding: [{ system: FHIR_CONDITION_VERIFICATION_SYSTEM, code: "unconfirmed" }] } }
        : {}),
      category: [{ text: "Antecedente" }],
      code: diagnosisCodeable(c.diagnosisSystem, c.diagnosisCode, c.name),
      ...(c.startDate ? { onsetDateTime: c.startDate } : {}),
      ...statedBy("conditions", c.id, "asserter"),
    })
  for (const m of record.medications) {
    // Terminada si su fin ya pasó; con un fin por venir sigue en curso, hasta esa fecha (como el PDF).
    const stated = statedBy("medications", m.id, "informationSource")
    const notes = [...((stated.note as Array<{ text: string }> | undefined) ?? []), ...(m.notes ? [{ text: m.notes }] : [])]
    resources.push({
      resourceType: "MedicationStatement",
      id: m.id,
      subject: patientRef,
      // La que no volvió a nombrar al decir que cambió: no se sabe si la sigue tomando (R4 `unknown`).
      status: !isCurrentMedication(m, record.today) ? "completed" : record.changed?.medications.includes(m.id) ? "unknown" : "active",
      // Con su código ATC, si lo tiene: el del medicamento, o el de su clase (B01A, M05B) si lo dijo
      // al responder por ella (auditor, A15: la warfarina viajaba solo como texto).
      medicationCodeableConcept: {
        ...(m.atcCode ? { coding: [{ system: FHIR_ATC_SYSTEM, code: m.atcCode }] } : {}),
        text: m.name,
      },
      ...(m.startDate || m.endDate
        ? { effectivePeriod: { ...(m.startDate ? { start: m.startDate } : {}), ...(m.endDate ? { end: m.endDate } : {}) } }
        : {}),
      ...stated,
      ...(notes.length ? { note: notes } : {}),
      ...(m.dose || m.frequency
        ? { dosage: [{ text: [m.dose, m.frequency].filter(Boolean).join(" · ") }] }
        : {}),
    })
  }
  // «Tus medicinas»: el «No», el «No sé» y lo que dijo sin nombre de las dos clases, con su grupo ATC
  // (B01A, M05B) y quién lo dijo; lo que nadie preguntó no se inventa (QA de la entrega 6).
  for (const item of record.medicineClasses) {
    const status = MEDICINE_CLASS_FHIR[item.answer]
    if (!status) continue
    resources.push({
      resourceType: "MedicationStatement",
      id: `clase-${item.group}`,
      subject: patientRef,
      status,
      medicationCodeableConcept: {
        coding: [{ system: FHIR_ATC_SYSTEM, code: MEDICATION_CLASSES[item.group].atc }],
        text: MEDICATION_CLASSES[item.group].label,
      },
      ...(item.said ? { informationSource: patientRef } : {}),
      note: [{ text: MEDICINE_CLASS_WORDS[item.answer] }],
    })
  }
  // Quién revisó los antecedentes y las alergias: en R4, una `Provenance` con quien verificó
  // (`verifier`), sobre lo que ya no está «sin revisar» (QA de la entrega 2: la ficha lo decía y la
  // copia no).
  const reviewProvenance = (
    id: string,
    review: { at: Date; by: string | null } | null,
    targets: Array<{ reference: string }>,
  ) => {
    if (!review || targets.length === 0) return
    resources.push({
      resourceType: "Provenance",
      id,
      target: targets,
      recorded: review.at.toISOString(),
      agent: [
        {
          type: { coding: [{ system: FHIR_PROVENANCE_PARTICIPANT_SYSTEM, code: "verifier" }] },
          who: { display: review.by ?? "El equipo de la clínica" },
        },
      ],
    })
  }
  // Solo lo que esa revisión pudo ver: lo que ya existía al revisar, del grupo que cubrió, y no lo que
  // sigue sin revisar ni la alergia «no confirmada» (revisor, QA de la entrega 2: una alergia anotada
  // el 8 salía verificada el 1).
  const reviewedBefore = (row: { createdAt: Date }, at: Date) => row.createdAt.getTime() <= at.getTime()
  for (const scope of reviewScopes(record)) {
    const at = scope.review.at
    const targets = [
      ...(scope.topics.includes("conditions")
        ? record.conditions
            .filter((c) => reviewedBefore(c, at) && !declaredGroupOf(record, "conditions", c.id))
            .map((c) => ({ reference: `Condition/${c.id}` }))
        : []),
      ...(scope.topics.includes("medications")
        ? record.medications
            .filter((m) => reviewedBefore(m, at) && !declaredGroupOf(record, "medications", m.id))
            .map((m) => ({ reference: `MedicationStatement/${m.id}` }))
        : []),
      ...(scope.topics.includes("allergies")
        ? record.allergies
            .filter(
              (a) => reviewedBefore(a, at) && a.verification !== "no_confirmada" && !declaredGroupOf(record, "allergies", a.id),
            )
            .map((a) => ({ reference: `AllergyIntolerance/${a.id}` }))
        : []),
    ]
    reviewProvenance(
      `${p.patientId}-${scope.topics.includes("allergies") ? "alergias-revisadas" : "antecedentes-revisados"}`,
      scope.review,
      targets,
    )
  }
  for (const { row, diagnoses, procedures, notDone, exam } of record.encounters) {
    const encounterRef = { reference: `Encounter/${row.id}` }
    // Lo observado vale como la atención: definitivo solo si se firmó, en curso si no, y
    // anulado si se anuló (como sus procedimientos). Un borrador no viaja como «final».
    const observationStatus =
      row.status === "anulada" ? "entered-in-error" : row.status === "finalizada" ? "final" : "preliminary"
    const signer = practitionerRef({ name: row.signerName, title: row.signerTitle, registration: row.signerRegistration })
    resources.push({
      resourceType: "Encounter",
      id: row.id,
      status: fhirCode(ENCOUNTER_STATUS_FHIR, row.status) ?? "unknown",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: "AMB",
        display: "ambulatory",
      },
      subject: patientRef,
      // Quien la llevó y firmó (R4 `participant.individual`), y la clínica (`serviceProvider`).
      ...(signer ? { participant: [{ individual: signer }] } : {}),
      period: {
        start: row.startedAt.toISOString(),
        ...(row.endedAt ? { end: row.endedAt.toISOString() } : {}),
      },
      ...(row.reason ? { reasonCode: [{ text: row.reason }] } : {}),
      serviceProvider: organizationRef,
    })
    // Las notas clínicas de la atención: en R4 no hay un recurso de nota suelta; va como
    // Observation con el código LOINC de la nota de evolución (11506-3, «Progress note»).
    for (const note of record.clinicalNotes.filter((n) => n.encounterId === row.id))
      resources.push(clinicalNoteObservation(note, patientRef, encounterRef, observationStatus))
    // La anestesia que guardó la firma: una Observation de la atención, en palabras (no hay un código
    // estándar para «lo que se calculó al firmar»), con el peso de entonces en UCUM.
    if (row.anesthesiaAtSigning)
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-anestesia`,
        status: observationStatus,
        code: { text: "Anestesia local al firmar la atención" },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: (row.endedAt ?? row.startedAt).toISOString(),
        valueString: anesthesiaLines(row.anesthesiaAtSigning, record.clinic).join(" · "),
        ...(row.anesthesiaAtSigning.weightKg !== null
          ? {
              component: [
                {
                  code: { coding: [{ system: FHIR_LOINC_SYSTEM, code: "29463-7", display: "Body weight" }], text: "Peso" },
                  valueQuantity: { value: row.anesthesiaAtSigning.weightKg, unit: "kg", system: FHIR_UCUM_SYSTEM, code: "kg" },
                },
              ],
            }
          : {}),
      })
    for (const d of diagnoses)
      resources.push({
        resourceType: "Condition",
        id: d.id,
        subject: patientRef,
        encounter: encounterRef,
        clinicalStatus: {
          coding: [
            {
              system: FHIR_CONDITION_CLINICAL_SYSTEM,
              code: fhirCode(CONDITION_CLINICAL_STATUS_FHIR, d.status) ?? "active",
            },
          ],
        },
        ...(d.diagnosisType
          ? {
              verificationStatus: {
                coding: [{ system: FHIR_CONDITION_VERIFICATION_SYSTEM, code: d.diagnosisType }],
              },
            }
          : {}),
        category: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/condition-category",
                code: "encounter-diagnosis",
              },
            ],
          },
        ],
        code: diagnosisCodeable(d.diagnosisSystem, d.diagnosisCode, d.title),
        ...(d.bodySite ? { bodySite: [d.bodySite] } : {}),
      })
    for (const pr of procedures)
      resources.push({
        resourceType: "Procedure",
        id: pr.id,
        status:
          row.status === "anulada"
            ? "entered-in-error"
            : row.status === "finalizada"
              ? "completed"
              : "in-progress",
        subject: patientRef,
        encounter: encounterRef,
        code: { text: pr.description },
        ...(pr.bodySite ? { bodySite: [pr.bodySite] } : {}),
        performedDateTime: pr.createdAt.toISOString(),
        ...(signer ? { performer: [{ actor: signer }] } : {}),
        // El tratamiento del plan que cumple (R4 `basedOn` → su ServiceRequest).
        ...(pr.planItemId ? { basedOn: [{ reference: `ServiceRequest/${pr.planItemId}` }] } : {}),
      })
    // Lo firmado por error y marcado «No se hizo»: el registro no debió existir (R4 `entered-in-error`).
    for (const pr of notDone)
      resources.push({
        resourceType: "Procedure",
        id: pr.id,
        status: "entered-in-error",
        subject: patientRef,
        encounter: encounterRef,
        code: { text: pr.description },
        ...(pr.bodySite ? { bodySite: [pr.bodySite] } : {}),
        performedDateTime: pr.createdAt.toISOString(),
        ...(pr.voidReason ? { note: [{ text: pr.voidReason }] } : {}),
      })
    // La enfermedad actual de la anamnesis. El relato lleva su sección LOINC (10164-2, «History
    // of present illness Narrative»). El tiempo no tiene código propio: en LOINC la duración es
    // parte de ese relato, así que viaja como texto, sin inventar un código.
    if (row.illnessDuration)
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-tiempo-enfermedad`,
        status: observationStatus,
        code: { text: "Tiempo de enfermedad" },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: row.startedAt.toISOString(),
        valueString: row.illnessDuration,
      })
    if (row.presentIllness)
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-relato-enfermedad`,
        status: observationStatus,
        code: {
          coding: [{ system: FHIR_LOINC_SYSTEM, code: "10164-2", display: "History of present illness Narrative" }],
          text: "Relato de la enfermedad",
        },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: row.startedAt.toISOString(),
        valueString: row.presentIllness,
      })
    // Lo que seguía sin revisar al firmar, una por declaración: lo que dijo, con quién y cuándo en la
    // nota. Sin un código propio en LOINC ni SNOMED para «sin revisar al firmar»: va como texto.
    for (const [index, group] of (row.healthAtSigning ?? []).entries()) {
      const words = healthAtSigningWords(group, p.sex, record.clinic)
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-sin-revisar-al-firmar-${index + 1}`,
        status: observationStatus,
        code: { text: "Lo que dijo de su salud y seguía sin revisar al firmar" },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: (row.endedAt ?? row.startedAt).toISOString(),
        valueString: words.said,
        note: [{ text: words.mark }],
      })
    }
    const vitals = (row.vitals ?? {}) as Record<string, unknown>
    for (const v of VITAL_SIGNS) {
      const value = vitals[v.key]
      if (typeof value !== "number") continue
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-${v.key}`,
        status: observationStatus,
        category: [{ coding: [{ system: FHIR_OBSERVATION_CATEGORY_SYSTEM, code: "vital-signs" }] }],
        code: {
          coding: [{ system: FHIR_LOINC_SYSTEM, code: v.loinc, display: v.label }],
          text: v.label,
        },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: row.startedAt.toISOString(),
        valueQuantity: { value, unit: v.suffix, system: FHIR_UCUM_SYSTEM, code: v.unit },
      })
    }
    // El examen por partes; lo no examinado va sin valor y con su motivo (issue 229, decisión 5).
    for (const part of exam.observations)
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-examen-${part.key}`,
        status: observationStatus,
        category: [{ coding: [{ system: FHIR_OBSERVATION_CATEGORY_SYSTEM, code: "exam" }] }],
        code: { text: part.text },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: row.startedAt.toISOString(),
        ...(part.value === null
          ? {
              dataAbsentReason: {
                coding: [{ system: FHIR_DATA_ABSENT_REASON_SYSTEM, code: "not-performed" }],
              },
            }
          : { valueString: part.value }),
        ...(part.interpretation
          ? {
              interpretation: [
                {
                  coding: [
                    { system: FHIR_OBSERVATION_INTERPRETATION_SYSTEM, code: part.interpretation },
                  ],
                },
              ],
            }
          : {}),
      })
  }
  for (const { row, items } of record.prescriptions) {
    const prescriber = practitionerRef({ name: row.prescriberName, title: row.prescriberTitle, registration: row.prescriberRegistration })
    for (const item of items)
      resources.push({
        resourceType: "MedicationRequest",
        id: item.id,
        status: fhirCode(PRESCRIPTION_STATUS_FHIR, row.status) ?? "unknown",
        // La anulada, con su motivo (R4 `statusReason`): la de Rosa, por su alergia (C1).
        ...(row.status === "anulada" && row.cancelReason ? { statusReason: { text: row.cancelReason } } : {}),
        intent: "order",
        subject: patientRef,
        ...(row.encounterId ? { encounter: { reference: `Encounter/${row.encounterId}` } } : {}),
        authoredOn: row.issuedAt.toISOString(),
        ...(prescriber ? { requester: prescriber } : {}),
        medicationCodeableConcept: {
          ...(item.atcCode
            ? { coding: [{ system: FHIR_ATC_SYSTEM, code: item.atcCode }] }
            : {}),
          text: [item.medicationName, item.strength].filter(Boolean).join(" "),
        },
        dosageInstruction: [
          {
            text: [item.dose, item.route, item.frequency, item.duration, item.instructions]
              .filter(Boolean)
              .join(" · ") || "Sin indicaciones escritas",
          },
        ],
      })
  }
  pushPlanAndOrders(record, resources, patientRef, practitionerRef)
  for (const a of record.appointments)
    resources.push({
      resourceType: "Appointment",
      id: a.id,
      status: fhirCode(APPOINTMENT_STATUS_FHIR, a.status) ?? "booked",
      ...(a.serviceName ? { serviceType: [{ text: a.serviceName }] } : {}),
      start: a.startsAt.toISOString(),
      end: a.endsAt.toISOString(),
      participant: [{ actor: patientRef, status: "accepted" }],
    })
  for (const c of record.consents) {
    // Su PDF, el que va en la carpeta «papeles» (R4 `Consent.sourceAttachment`), y de qué
    // tratamiento es (`provision.data`, `meaning: instance`, al ServiceRequest con su pieza).
    const paper = record.papers.find((item) => item.kind === "consentimiento" && item.id === c.id)
    resources.push({
      resourceType: "Consent",
      id: c.id,
      // Lo que firmó por su enlace y nadie confirmó sigue `proposed`: no es un consentimiento en pie.
      text: {
        status: "generated",
        div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${xhtml(consentWords(c, record.clinic))}</p></div>`,
      },
      status: fhirCode(CONSENT_STATUS_FHIR, c.status) ?? "proposed",
      scope: { coding: [FHIR_CONSENT_SCOPE] },
      category: [{ coding: [FHIR_CONSENT_CATEGORY], text: c.titleSnapshot }],
      patient: patientRef,
      ...(c.signedAt ? { dateTime: c.signedAt.toISOString() } : {}),
      organization: [organizationRef],
      ...(paper ? { sourceAttachment: paperAttachment(paper) } : {}),
      policyRule: { text: c.titleSnapshot },
      ...(c.planItemId && record.planItems.some((item) => item.id === c.planItemId)
        ? { provision: { data: [{ meaning: "instance", reference: { reference: `ServiceRequest/${c.planItemId}` } }] } }
        : {}),
    })
  }
  // Las fichas finalizadas y lo que respondió la persona, revisado o no.
  const exportedDocuments = new Set(record.documents.map((d) => d.id))
  for (const form of record.forms) {
    // Sin ninguna pregunta que leer (una plantilla antigua mal guardada) no hay qué exportar: FHIR no admite listas vacías.
    if (form.sections.length === 0) continue
    const related = record.contacts.find((c) => c.contactId === form.respondentContactId)
    // Quien respondió desde su enlace: la paciente, alguien vinculado a ella u otra persona, por su nombre.
    const respondent =
      form.source !== "portal"
        ? null
        : form.filledByPatient
          ? patientRef
          : related
            ? { reference: `RelatedPerson/${relatedPersonId(p.patientId, related.contactId)}`, display: related.displayName }
            : form.filledBy
              ? { display: form.filledBy }
              : null
    // R4: `authored` es cuándo se dieron las respuestas. Lo que respondió la persona es de cuando lo
    // envió, no de cuando el equipo lo revisó (auditor, QA de la entrega 2); la revisión va en el texto.
    const authored = formRecordAt(form) ?? record.generatedAt
    resources.push(
      questionnaireResponse({
        id: form.id,
        title: form.title,
        version: form.version,
        authored,
        // De una atención anulada ya no vale; con algo agregado después, enmendado.
        status: form.voidedAttention ? "entered-in-error" : form.addenda.length ? "amended" : "completed",
        patientRef,
        encounterId: form.encounterId,
        author: respondent ?? (form.filledBy ? { display: form.filledBy } : null),
        source: respondent,
        groups: form.sections.map((group) => ({
          // Una sección y una pregunta pueden llamarse igual: el prefijo las distingue (un id de pregunta no lleva «:»).
          linkId: `seccion:${group.id}`,
          text: group.title,
          items: group.items.map((item) => ({
            linkId: item.id,
            text: item.unit ? `${item.label} (${item.unit})` : item.label,
            type: FORM_FIELD_TYPE_FHIR[item.type],
            repeats: item.type === "opcion_multiple",
            options: item.options,
            answers: formAnswers(item, exportedDocuments),
            // Quién dio cada respuesta, si no la dio toda una sola persona: lo que propuso Clío es suyo
            // (quien lo confirmó va en su `Provenance`), lo demás de quien lo escribió (QA final, H10).
            author: item.clioConfirmed
              ? { display: CLIO_NAME }
              : item.writtenBy
                ? { display: item.writtenBy }
                : null,
          })),
        })),
        notes: [
          form.byWords,
          ...(form.voidedAttention ? [voidedFormWords(form, record.clinic) as string] : []),
          ...form.addenda.map(
            (addendum) =>
              `${form.addendaTitle === "Correcciones" ? "Corrección" : "Adenda"}: ${addendumWords(addendum, record.clinic)}`,
          ),
        ],
      }),
    )
    // Cada adenda o corrección: quién la agregó, cuándo y por qué, en los campos de R4 para eso
    // (`Provenance`, con `reason`); su texto va en el del recurso.
    for (const addendum of form.addenda)
      resources.push({
        resourceType: "Provenance",
        id: addendum.id,
        target: [{ reference: `QuestionnaireResponse/${form.id}` }],
        recorded: addendum.createdAt.toISOString(),
        activity: { coding: [{ system: FHIR_DATA_OPERATION_SYSTEM, code: "APPEND" }] },
        ...(addendum.reason ? { reason: [{ text: addendum.reason }] } : {}),
        agent: [
          {
            type: { coding: [{ system: FHIR_PROVENANCE_PARTICIPANT_SYSTEM, code: "author" }] },
            who: { display: addendum.authorName ?? "El equipo de la clínica" },
          },
        ],
      })
    // Lo que propuso Clío y confirmó una persona, como lo dice el PDF: en R4, una `Provenance` con
    // Clío como autor y quien lo confirmó como `verifier` (QA final de formularios, H10). R4 no apunta
    // a una pregunta de la respuesta: su texto la nombra, y la pregunta lleva a Clío como autor.
    for (const item of form.sections.flatMap((group) => group.items)) {
      if (!item.clioConfirmed) continue
      const confirmer = item.clioConfirmed.by ?? "El equipo de la clínica"
      resources.push({
        resourceType: "Provenance",
        id: uuidV5(form.id, `clio/${item.id}`),
        text: {
          status: "generated",
          div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${xhtml(`${item.label}: lo propuso ${CLIO_NAME} al dictar y lo confirmó ${confirmer}.`)}</p></div>`,
        },
        target: [{ reference: `QuestionnaireResponse/${form.id}` }],
        recorded: item.clioConfirmed.at.toISOString(),
        agent: [
          { type: { coding: [{ system: FHIR_PROVENANCE_PARTICIPANT_SYSTEM, code: "author" }] }, who: { display: CLIO_NAME } },
          { type: { coding: [{ system: FHIR_PROVENANCE_PARTICIPANT_SYSTEM, code: "verifier" }] }, who: { display: confirmer } },
        ],
      })
    }
  }
  // La entrevista de salud vigente, como la cuenta el producto: cada dato en palabras.
  if (record.interview)
    resources.push(
      questionnaireResponse({
        id: `${p.patientId}-entrevista`,
        title: "Entrevista de salud",
        version: record.interview.version,
        authored: record.interview.said.at,
        patientRef,
        // Quien la anotó, si fue el equipo; quien la dijo, si se declaró y consta quién.
        author:
          record.interview.said.kind === "recorded" && record.interview.said.by
            ? { display: record.interview.said.by }
            : null,
        source: record.interview.said.kind === "declared" ? asserterOf(record.interview.said.by, patientRef) : null,
        groups: [
          {
            linkId: "entrevista",
            text: "Entrevista de salud",
            items: record.interview.entries.map((entry) => ({
              linkId: entry.key,
              text: entry.label,
              type: "string",
              answers: [{ valueString: entry.value }],
            })),
          },
        ],
        notes: [
          saidWords(record.interview.said, p.sex, record.clinic),
          ...record.interview.entries.flatMap((entry) => {
            const note = entryNote(entry, p.sex, record.clinic)
            return note ? [`${entry.label}: ${note}`] : []
          }),
        ],
      }),
    )
  // Cada declaración original, como lo que es: lo que envió, con su fecha y quién. La fuente es quien
  // lo dijo; nadie del equipo figura como autor.
  let previousDeclaration: string | null = null
  record.declarations.forEach((declaration, index) => {
    if (declaration.entries.length === 0) return
    const id = `${p.patientId}-declaracion-${index + 1}`
    const source = asserterOf(declaration.by, patientRef)
    resources.push(
      questionnaireResponse({
        id,
        title: "Declaración de salud",
        authored: declaration.at,
        patientRef,
        source,
        groups: [
          {
            linkId: "declaracion",
            text: declarationTitle(declaration),
            items: declaration.entries.map((entry) => ({
              linkId: entry.key,
              text: entry.label,
              type: "string",
              answers: [{ valueString: entry.value }],
            })),
          },
        ],
        notes: [
          `${declarationTitle(declaration)}. ${saidWhenWords(declaration.by, dayTimeWords(declaration.at, record.clinic), p.sex)}.`,
        ],
      }),
    )
    // Lo que volvió a responder antes de una cita (lo corrigió, o algo cambió) revisa lo que había
    // dicho: en R4, una `Provenance` con su motivo (`reason`), quién lo dijo y qué revisa (`entity`).
    if (declaration.reason === "correccion" || declaration.reason === "cambio")
      resources.push({
        resourceType: "Provenance",
        id: `${id}-motivo`,
        target: [{ reference: `QuestionnaireResponse/${id}` }],
        recorded: declaration.at.toISOString(),
        activity: { coding: [{ system: FHIR_DATA_OPERATION_SYSTEM, code: "UPDATE" }] },
        reason: [{ text: HEALTH_DECLARATION_REASON_LABELS[declaration.reason] }],
        agent: [
          {
            type: { coding: [{ system: FHIR_PROVENANCE_PARTICIPANT_SYSTEM, code: "author" }] },
            who: source ?? { display: "Quien lo declaró" },
          },
        ],
        ...(previousDeclaration
          ? { entity: [{ role: "revision", what: { reference: `QuestionnaireResponse/${previousDeclaration}` } }] }
          : {}),
      })
    previousDeclaration = id
  })
  // Lo que contó antes de cada cita: lo dijo quien lo envió (la fuente), no el equipo; la atención
  // es la de esa cita, si la hubo. La cita no tiene campo en `QuestionnaireResponse` de R4: va en el texto.
  for (const told of record.visitAnswers)
    resources.push(
      questionnaireResponse({
        id: told.id,
        title: "Antes de tu cita",
        authored: told.submittedAt,
        patientRef,
        encounterId: told.encounterId,
        source: asserterOf(told.by, patientRef),
        groups: [
          {
            linkId: "visita",
            text: `Para la cita del ${dayTimeWords(told.appointmentStartsAt, record.clinic)}`,
            items: visitRows(told).map(([label, value], index) => ({
              linkId: `visita-${index + 1}`,
              text: label,
              type: "string",
              answers: [{ valueString: value }],
            })),
          },
        ],
        notes: [`${visitToldWords(told, record.clinic, p.sex)}.`],
      }),
    )
  // El parentesco ya se guarda con su código HL7 v3 RoleCode. `partial`: es lo que se sabe de ese familiar.
  for (const row of record.familyHistory)
    resources.push({
      resourceType: "FamilyMemberHistory",
      id: row.id,
      status: "partial",
      patient: patientRef,
      date: row.updatedAt.toISOString(),
      relationship: {
        coding: [{ system: FHIR_ROLE_CODE_SYSTEM, code: row.relationship }],
        text: KINSHIP_LABELS[row.relationship as keyof typeof KINSHIP_LABELS] ?? row.relationship,
      },
      condition: [
        {
          code: diagnosisCodeable(row.diagnosisSystem, row.diagnosisCode, row.condition),
          ...(row.notes ? { note: [{ text: row.notes }] } : {}),
        },
      ],
    })
  // Cada archivo de la ficha, con su ruta dentro del ZIP (R4 `DocumentReference.content.attachment.url`).
  // Una tomografía es su carpeta de cortes: va como ImagingStudy, no como un archivo.
  const studyOf = new Map(record.imagingStudies.map((study) => [study.documentId, study]))
  for (const d of record.documents) {
    const study = studyOf.get(d.id)
    if (study) {
      resources.push(imagingStudyResource(d, study, patientRef, record.clinic.timezone))
      continue
    }
    resources.push({
      resourceType: "DocumentReference",
      id: d.id,
      status: "current",
      type: { text: d.label },
      category: [{ text: d.category }],
      subject: patientRef,
      date: d.createdAt.toISOString(),
      custodian: organizationRef,
      content: [
        {
          attachment: {
            contentType: d.contentType,
            title: d.label,
            url: zipUrl(`documentos/${documentFileName(d)}`),
            ...(d.sizeBytes ? { size: d.sizeBytes } : {}),
            // FHIR R4 Attachment.creation: cuándo se hizo el papel (o se tomó la imagen);
            // `date` es cuándo entró a la ficha.
            // Solo el día (FHIR admite fecha sola): un día elegido no tiene hora.
            ...(d.capturedAt ? { creation: clinicDay(d.capturedAt, record.clinic.timezone) } : {}),
          },
        },
      ],
    })
  }
  // Lo retirado: un DocumentReference `entered-in-error` sin el archivo, con su tipo, su fecha y su
  // motivo; ni su nombre ni su dirección (podía ser de otra persona).
  for (const d of record.retiredDocuments)
    resources.push({
      resourceType: "DocumentReference",
      id: d.id,
      status: "entered-in-error",
      type: { text: d.typeWords },
      subject: patientRef,
      date: d.retiredAt.toISOString(),
      description: `Retirado de su ficha (${d.typeWords.toLocaleLowerCase("es")})${d.reason ? `: ${d.reason}` : ""}`,
      content: [{ attachment: { title: `Retirado de su ficha (${d.typeWords.toLocaleLowerCase("es")}): el archivo no va en la copia` } }],
    })
  // Cada papel emitido, en su PDF dentro del ZIP: lo que documenta va en `context.related`.
  for (const paper of record.papers)
    resources.push({
      resourceType: "DocumentReference",
      id: uuidV5(p.patientId, `paper:${paper.kind}:${paper.id}`),
      // La huella del papel emitido: SHA-256 en hex. `Attachment.hash` de R4 es SHA-1 y va aparte.
      identifier: [{ type: { text: "SHA-256" }, value: paper.sha256 }],
      status: "current",
      type: { text: paper.label },
      category: [{ text: PAPER_KIND_WORDS[paper.kind] ?? "Papel" }],
      subject: patientRef,
      date: paper.at.toISOString(),
      ...(paper.mark ? { description: paper.mark } : {}),
      custodian: organizationRef,
      content: [{ attachment: paperAttachment(paper) }],
      ...(paper.related ? { context: { related: [{ reference: `${paper.related.resourceType}/${paper.related.id}` }] } } : {}),
    })
  // Las notas sueltas, como las de una atención.
  for (const note of record.clinicalNotes.filter((n) => !n.encounterId))
    resources.push(clinicalNoteObservation(note, patientRef, null, "final"))
  // Lo del producto (odentIA: cada pieza del odontograma y cada periodontograma).
  for (const product of record.productSections) resources.push(...((product.fhir ?? []) as Resource[]))
  // R4 pide que `fullUrl` sea una dirección absoluta, y un `urn:uuid` lleva un UUID: el id que no lo
  // es (`…-entrevista`, `…-examen-abdomen`) va con un UUID v5 suyo, que no tiene por qué ser su id
  // cuando es un `urn:uuid` (Bundle.entry.fullUrl). Así no se arma un `urn:uuid` que no lo es
  // (revisor, QA de la entrega 2) ni un `fullUrl` relativo.
  const unique = new Map<string, Resource>()
  for (const resource of resources) unique.set(`${resource.resourceType}/${resource.id}`, resource)
  const fullUrlOf = new Map(
    [...unique.keys()].map((key) => {
      const resource = unique.get(key) as Resource
      return [key, `urn:uuid:${UUID_RE.test(resource.id) ? resource.id : uuidV5(p.patientId, key)}`] as const
    }),
  )
  return {
    resourceType: "Bundle",
    type: "collection",
    meta: { tag: [{ system: "https://odentia32.com/fhir", code: `fhir-${FHIR_VERSION}` }] },
    timestamp: record.generatedAt.toISOString(),
    entry: [...unique.entries()].map(([key, resource]) => ({
      fullUrl: fullUrlOf.get(key) as string,
      resource: resolveBundleReferences(resource, fullUrlOf),
    })),
  }
}

/**
 * La ruta de un archivo dentro del ZIP como `url` de FHIR R4: una referencia relativa de RFC 3986,
 * con cada tramo codificado (un `url` de R4 no admite espacios: «^\S*$»). «documentos/Periapical
 * de la 46.jpg» va como «documentos/Periapical%20de%20la%2046.jpg».
 */
export function zipUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

/** Lo que va en «papeles» y no es un papel emitido: se dibuja al armar la copia (odentIA: el odontograma de hoy). */
export const UNISSUED_PAPER_KINDS: readonly string[] = ["odontogram_today"]

/** Qué es cada papel, como categoría de su DocumentReference. */
const PAPER_KIND_WORDS: Record<string, string> = {
  receta: "Receta",
  orden: "Orden",
  descanso: "Descanso médico",
  hoja: "Hoja de atención",
  consentimiento: "Consentimiento",
  signed_odontogram: "Odontograma firmado",
  odontogram_today: "Odontograma",
}

/** El PDF de un papel como Attachment de R4: su ruta en el ZIP, su tamaño y su SHA-1 en base64. */
function paperAttachment(paper: RecordPaperEntry): Record<string, unknown> {
  return {
    contentType: paper.contentType,
    url: zipUrl(paper.path),
    size: paper.size,
    hash: paper.sha1,
    title: paper.label,
    creation: paper.at.toISOString(),
  }
}

/**
 * Una nota clínica como Observation (LOINC 11506-3, nota de evolución), con quien la escribió. Su
 * estado es el de su atención, como lo demás observado en ella: de una atención anulada ya no vale
 * (`entered-in-error`); de un borrador, `preliminary`.
 */
function clinicalNoteObservation(
  note: PatientRecord["clinicalNotes"][number],
  patientRef: { reference: string },
  encounterRef: { reference: string } | null,
  status: string,
): Resource {
  return {
    resourceType: "Observation",
    id: note.id,
    status,
    code: { coding: [{ system: FHIR_LOINC_SYSTEM, code: "11506-3", display: "Progress note" }], text: "Nota clínica" },
    subject: patientRef,
    ...(encounterRef ? { encounter: encounterRef } : {}),
    effectiveDateTime: note.createdAt.toISOString(),
    ...(note.authorName ? { performer: [{ display: note.authorName }] } : {}),
    valueString: note.siteWords ? `${note.siteWords}: ${note.note}` : note.note,
  }
}

/**
 * Una tomografía como ImagingStudy de R4: el estudio por su StudyInstanceUID (`urn:oid:`, como dice
 * `imagingstudy.html`) y cada serie con su UID y su modalidad DICOM. Las instancias no se listan
 * (`series.instance.sopClass` es 1..1 y no se guarda): va cuántas son. Dónde están los cortes, en
 * la descripción: R4 no tiene un campo para una carpeta del ZIP.
 */
function imagingStudyResource(
  d: PatientRecord["documents"][number],
  study: PatientRecord["imagingStudies"][number],
  patientRef: { reference: string },
  timezone: string,
): Resource {
  const modality = study.modality?.trim() || "CT"
  return {
    resourceType: "ImagingStudy",
    id: d.id,
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${study.studyInstanceUid}` }],
    status: "available",
    modality: [{ system: FHIR_DICOM_MODALITY_SYSTEM, code: modality }],
    subject: patientRef,
    ...(d.capturedAt ? { started: clinicDay(d.capturedAt, timezone) } : {}),
    numberOfSeries: study.series.length || 1,
    numberOfInstances: study.fileCount,
    description: `${d.label}: sus cortes DICOM van en la carpeta «documentos/${documentFileName({ ...d, storageKey: "/" })}/DICOM» de esta copia.`,
    ...(study.series.length
      ? {
          series: study.series.map((series) => ({
            uid: series.uid,
            modality: { system: FHIR_DICOM_MODALITY_SYSTEM, code: modality },
            numberOfInstances: series.count,
          })),
        }
      : {}),
  }
}

/**
 * El plan (R4 CarePlan) con cada tratamiento como ServiceRequest, los controles como
 * ServiceRequest con su fecha y las órdenes como ServiceRequest con su DiagnosticReport si tienen
 * resultado. La decisión de la persona: aceptado es `intent: plan`; lo que espera respuesta,
 * `proposal`; un camino que compite con otro y aún no elige, `option` (R4 RequestIntent: una opción
 * entre varias); lo que no aceptó o no eligió, `revoked`. Sin precios: el plan dice qué se hará.
 */
function pushPlanAndOrders(
  record: PatientRecord,
  resources: Resource[],
  patientRef: { reference: string },
  practitionerRef: (s: { name: string | null; title: string | null; registration: string | null }) => { reference: string; display: string } | null,
): void {
  const zone = record.clinic
  const view = planView(record)
  const competing = new Set(view.paths.flatMap((path) => path.options.flatMap((option) => option.items.map(({ item }) => item.id))))
  const statusOf = (item: RecordPlanItem): string => {
    if (item.status === "realizado") return "completed"
    if (LEFT_OUT(item)) return "revoked"
    if (item.status === "suspendido") return "on-hold"
    return "active"
  }
  const intentOf = (item: RecordPlanItem): string => {
    if (competing.has(item.id)) return "option"
    return item.decision === "aceptado" || item.status === "realizado" || item.status === "en_curso" ? "plan" : "proposal"
  }
  const activities: Array<{ reference: string }> = []
  for (const item of record.planItems) {
    activities.push({ reference: `ServiceRequest/${item.id}` })
    resources.push({
      resourceType: "ServiceRequest",
      id: item.id,
      status: statusOf(item),
      intent: intentOf(item),
      category: [{ text: "Tratamiento del plan" }],
      code: { text: item.title },
      subject: patientRef,
      ...(item.diagnosisCode ? { reasonCode: [diagnosisCodeable(item.diagnosisSystem, item.diagnosisCode, item.diagnosisName)] } : {}),
      ...(item.bodySite ? { bodySite: [item.bodySite] } : {}),
      authoredOn: item.createdAt.toISOString(),
      ...(item.nextAppointmentAt ? { occurrenceDateTime: item.nextAppointmentAt.toISOString() } : {}),
      // Lo que se dice en la ficha, con su decisión, sus sesiones y «va después de».
      note: [{ text: planItemWords(item, zone) }],
    })
  }
  for (const f of record.followUps) {
    activities.push({ reference: `ServiceRequest/${f.id}` })
    resources.push({
      resourceType: "ServiceRequest",
      id: f.id,
      status: f.status === "realizado" ? "completed" : f.status === "cancelado" ? "revoked" : "active",
      intent: "plan",
      category: [{ text: "Control" }],
      code: { text: f.title },
      subject: patientRef,
      occurrenceDateTime: (f.appointmentAt ?? f.dueAt).toISOString(),
      note: [{ text: followUpWords(f, zone) }],
    })
  }
  if (activities.length) {
    const notes = view.paths.map((path) => ({ text: pathWords(path, zone) }))
    resources.push({
      resourceType: "CarePlan",
      id: uuidV5(record.person.patientId, "CarePlan:plan"),
      status: record.planItems.some((item) => OPEN_PLAN_STATUSES.includes(item.status) && !LEFT_OUT(item)) ? "active" : "completed",
      intent: "plan",
      title: "Plan de tratamiento",
      subject: patientRef,
      created: record.generatedAt.toISOString(),
      activity: activities.map((reference) => ({ reference })),
      ...(notes.length ? { note: notes } : {}),
    })
  }
  for (const o of record.orders) {
    const requester = practitionerRef({ name: o.signerName, title: o.signerTitle, registration: o.signerRegistration })
    resources.push({
      resourceType: "ServiceRequest",
      id: o.id,
      // Sin resultado sigue `active`; con él, `completed`; la anulada, `revoked` con su motivo en la nota.
      status: o.status === "cancelado" ? "revoked" : o.status === "completado" ? "completed" : "active",
      intent: "order",
      category: [{ text: o.kindWords }],
      code: { text: o.title },
      subject: patientRef,
      ...(o.encounterId ? { encounter: { reference: `Encounter/${o.encounterId}` } } : {}),
      authoredOn: o.createdAt.toISOString(),
      ...(requester ? { requester } : {}),
      ...(o.recipient ? { performer: [{ display: o.recipient }] } : {}),
      ...(o.diagnosisCode ? { reasonCode: [diagnosisCodeable(o.diagnosisSystem, o.diagnosisCode, o.diagnosisName)] } : {}),
      note: [{ text: orderWords(o, zone, record) }],
    })
    if (o.status !== "completado") continue
    const file = o.resultDocumentId ? record.documents.find((d) => d.id === o.resultDocumentId) : undefined
    resources.push({
      resourceType: "DiagnosticReport",
      id: uuidV5(record.person.patientId, `DiagnosticReport:${o.id}`),
      basedOn: [{ reference: `ServiceRequest/${o.id}` }],
      status: "final",
      code: { text: o.title },
      subject: patientRef,
      ...(o.resultAt ? { issued: o.resultAt.toISOString() } : {}),
      ...(o.resultText ? { conclusion: o.resultText } : {}),
      ...(file
        ? { presentedForm: [{ contentType: file.contentType, url: zipUrl(`documentos/${documentFileName(file)}`), title: file.label }] }
        : {}),
    })
  }
}

function diagnosisCodeable(system: string | null, code: string | null, text: string | null) {
  const uri = system && isDiagnosisSystem(system) ? DIAGNOSIS_SYSTEM_INFO[system].uri : null
  return {
    ...(code && uri ? { coding: [{ system: uri, code }] } : {}),
    text: text ?? code ?? "Sin descripción",
  }
}

/** El día (AAAA-MM-DD) de un instante en la zona de la clínica. */
function clinicDay(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value)
}

/**
 * La fecha de un documento en la copia: su día (la de toma, en una imagen), sin una
 * hora que nadie puso, y cuándo se subió; sin fecha propia, solo cuándo se subió.
 */
export function documentDateWords(
  d: { category: string; capturedAt: Date | null; createdAt: Date },
  zone: Zone,
): string {
  const uploaded = `subido el ${dayTimeWords(d.createdAt, zone)}`
  if (!d.capturedAt) return uploaded
  return `${isImageDocumentCategory(d.category) ? "tomada el" : "del"} ${dayWords(d.capturedAt, zone)} (${uploaded})`
}

/** El nombre de un documento dentro del ZIP: su id y su extensión, para que no choquen. */
export function documentFileName(d: { id: string; label: string; storageKey: string }): string {
  // «Consentimiento firmado: Exodoncia» → «Consentimiento firmado - Exodoncia».
  const label = d.label
    .replace(/\s*[\\/:*?"<>|]+\s*/g, " - ")
    .trim()
    .slice(0, 80)
  const name = `${label} (${d.id.slice(0, 8)})`
  // Una tomografía es una carpeta con sus cortes: su nombre va sin extensión.
  if (d.storageKey.endsWith("/")) return name
  const last = d.storageKey.slice(d.storageKey.lastIndexOf("/") + 1)
  return last.includes(".") ? `${name}.${last.slice(last.lastIndexOf(".") + 1)}` : name
}

// --- Enviar la copia a la persona ----------------------------------------------

export interface RecordSendOptions {
  /** Quien lo pidió: la propia persona o su representante legal vigente. */
  recipient: { contactId: string; displayName: string } | null
  /** Solo WhatsApp y correo, con si sirven y por qué no. */
  channels: DocumentChannelOption[]
}

/** Por dónde se le puede enviar la copia a quien la pidió. */
export async function recordSendOptions(
  tx: Db,
  orgId: string,
  patientId: string,
  requestId: string,
): Promise<RecordSendOptions> {
  const request = await copyRequest(tx, orgId, patientId, requestId)
  const recipient = (await listDecisionRecipients(tx, orgId, patientId)).find(
    (r) => r.contactId === request.requesterContactId,
  )
  if (!recipient) return { recipient: null, channels: [] }
  // Pasadas las 24 horas de WhatsApp sale con «Documento listo», como los demás papeles (ADR 0156):
  // el enlace a la copia completa va dentro del PDF, así que viaja igual.
  const { channels: all } = await documentChannelsFor(tx, orgId, recipient, { documentTemplate: true })
  const channels = all.filter((o) => o.channel === "whatsapp" || o.channel === "email")
  const proposed = proposeHealthChannel(channels)
  if (proposed) proposed.isProposed = true
  return {
    recipient: { contactId: recipient.contactId, displayName: recipient.displayName },
    channels,
  }
}

async function copyRequest(tx: Db, orgId: string, patientId: string, requestId: string) {
  const [request] = await listDataRequests(tx, orgId, patientId, { id: requestId })
  if (!request) throw notFound("Pedido")
  if (request.kind !== "copia") throw validation("Este pedido no es una copia")
  return request
}

const CHANNEL_WORDS: Record<string, string> = { whatsapp: "WhatsApp", email: "correo" }

/**
 * Envía el PDF de la historia a quien lo pidió y responde el pedido. Lo puede
 * hacer Recepción: el servidor lo arma y lo envía sin mostrárselo. Exige haber
 * comprobado que es ella. En la primera página del PDF va «Su enlace» para bajar
 * la copia completa (`issueRecordCopyLink`), nunca en el texto del mensaje.
 * «Enviar de nuevo» es esta misma operación sobre el pedido ya respondido con su
 * copia enviada: le da otros días a su enlace y no vuelve a responder el pedido.
 */
export async function sendPatientRecordCopy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  requestId: string,
  /** `again`: «Enviar de nuevo», dicho por quien lo pulsa; nunca se deduce de lo guardado. */
  input: { connectionId: string; again?: boolean },
  deps: SendDeps,
): Promise<{ request: DataRequestItem; conversationId: string; channel: string }> {
  const request = await copyRequest(tx, orgId, patientId, requestId)
  const again = input.again === true
  // Una pestaña vieja que vuelve a «Enviar» no reenvía: el reenvío es explícito y solo de una copia enviada con su enlace.
  if (!again && request.status !== "pendiente")
    throw new ServiceError(
      "DATA_REQUEST_CLOSED",
      409,
      "Este pedido ya se respondió y su copia ya salió. Si hay que mandarla otra vez, usa «Enviar de nuevo».",
    )
  if (again && (request.status !== "respondida" || request.copy === null))
    throw new ServiceError(
      "DATA_REQUEST_CLOSED",
      409,
      request.status === "pendiente"
        ? "Esta copia todavía no se envió: usa «Enviar la copia»."
        : "Este pedido no tiene una copia enviada con su enlace para enviar de nuevo.",
    )
  if (!request.verifiedAt)
    throw new ServiceError(
      "DATA_REQUEST_NOT_VERIFIED",
      409,
      "Primero comprueba que es ella o su representante",
    )
  const recipient = (await listDecisionRecipients(tx, orgId, patientId)).find(
    (r) => r.contactId === request.requesterContactId,
  )
  if (!recipient)
    throw new ServiceError(
      "DOCUMENT_RECIPIENT_NOT_AUTHORIZED",
      403,
      "La copia solo se envía a la propia persona o a su representante legal",
    )
  const conn = await requireDocumentConnection(tx, orgId, input.connectionId)
  if (conn.channel !== "whatsapp" && conn.channel !== "email")
    throw validation("La copia se envía por WhatsApp o por correo")
  // Un token propio, de un solo propósito, que viaja solo dentro del PDF (no «Su enlace»).
  const link = await issueRecordCopyLink(tx, orgId, { requestId })
  const record = await loadPatientRecord(tx, orgId, patientId)
  const pdf = await renderPatientRecordPdf(record, record.clinic, link ? { copyLink: link } : undefined)
  const { conversationId, messageId } = await deliverDocumentPdf(
    tx,
    orgId,
    actorUserId,
    {
      recipient,
      conn,
      pdf,
      filename: patientRecordFileName(record, "pdf"),
      caption: recordCopyCaption({
        clinicName: record.clinic.tradeName,
        patientFirstName:
          recipient.relation === "paciente" ? null : (record.person.givenNames ?? record.person.displayName).split(/\s+/)[0] ?? null,
        until: link ? await recordCopyDayWords(tx, orgId, link.until) : null,
      }),
      // Pasadas las 24 horas, con «Documento listo» y el PDF en su encabezado (ADR 0156).
      allowTemplate: true,
    },
    deps,
  )
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient_record.sent",
    entity: "message",
    entityId: messageId,
    metadata: {
      patientId,
      requestId,
      conversationId,
      channel: conn.channel,
      again,
      copyUntil: link?.until.toISOString() ?? null,
    },
  })
  if (again) {
    const [sent] = await listDataRequests(tx, orgId, patientId, { id: requestId })
    return { request: sent!, conversationId, channel: conn.channel }
  }
  const via = CHANNEL_WORDS[conn.channel] ?? conn.channel
  const responded = await respondDataRequest(tx, orgId, actorUserId, patientId, requestId, {
    resolution: link
      ? `Se le envió por ${via} el PDF de su historia, con el enlace para bajar la copia completa.`
      : `Se le envió por ${via} el PDF de su historia.`,
  })
  return { request: responded, conversationId, channel: conn.channel }
}

/**
 * Los archivos de la persona para el ZIP, con su nombre dentro de él. Una
 * tomografía no es un archivo sino sus cortes DICOM: van todos, en su carpeta,
 * y solo si ya terminó de subirse.
 */
export async function patientRecordFiles(
  tx: Db,
  orgId: string,
  record: PatientRecord,
): Promise<Array<{ name: string; storageKey: string }>> {
  const ids = record.documents.map((d) => d.id)
  const studies = ids.length
    ? await tx
        .select({ documentId: imagingStudy.documentId, completedAt: imagingStudy.completedAt })
        .from(imagingStudy)
        .where(and(eq(imagingStudy.organizationId, orgId), inArray(imagingStudy.documentId, ids)))
    : []
  const studyOf = new Map(studies.map((s) => [s.documentId, s]))
  const files: Array<{ name: string; storageKey: string }> = []
  for (const d of record.documents) {
    const study = studyOf.get(d.id)
    if (!study) {
      files.push({ name: `documentos/${documentFileName(d)}`, storageKey: d.storageKey })
      continue
    }
    if (!study.completedAt) continue
    const slices = await tx
      .select({ index: imagingStudyFile.fileIndex, storageKey: imagingStudyFile.storageKey })
      .from(imagingStudyFile)
      .where(and(eq(imagingStudyFile.organizationId, orgId), eq(imagingStudyFile.documentId, d.id)))
      .orderBy(asc(imagingStudyFile.fileIndex))
    const folder = documentFileName({ ...d, storageKey: "/" })
    for (const slice of slices)
      files.push({
        name: `documentos/${folder}/DICOM/${String(slice.index + 1).padStart(5, "0")}.dcm`,
        storageKey: slice.storageKey,
      })
  }
  return files
}
