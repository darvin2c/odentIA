/**
 * La historia completa de una persona, para entregársela (issue 45 mínimo,
 * ADR 0080): un PDF para leer y un paquete HL7 FHIR R4 para que otra clínica
 * la cargue. Las imágenes y documentos van aparte, en el ZIP de la API.
 *
 * Lee todo lo clínico de la persona: solo la piden quienes leen la ficha
 * clínica (`clinical.read`). El envío a la propia persona lo hace el servidor
 * sin mostrarla a quien lo pide (Recepción).
 */
import { createHash } from "node:crypto"
import {
  ALLERGY_CATEGORY_FHIR,
  ALLERGY_CRITICALITY_FHIR,
  ALLERGY_SEVERITY_FHIR,
  ALLERGY_TYPE_FHIR,
  ALLERGY_VERIFICATION_FHIR,
  APPOINTMENT_STATUS_FHIR,
  CONDITION_CLINICAL_STATUS_FHIR,
  CONSENT_STATUS_FHIR,
  DIAGNOSIS_SYSTEM_INFO,
  ENCOUNTER_STATUS_FHIR,
  FHIR_ALLERGY_CLINICAL_SYSTEM,
  FHIR_ALLERGY_VERIFICATION_SYSTEM,
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
  type HealthDeclarant,
  HL7_IDENTIFIER_TYPE_SYSTEM,
  hl7DocumentTypeCode,
  type InterviewEntry,
  isDiagnosisSystem,
  isCurrentMedication,
  isImageDocumentCategory,
  KINSHIP_LABELS,
  PREGNANCY_ENTRY_KEY,
  PRESCRIPTION_STATUS_FHIR,
  saidNoWords,
  saidWhenWords,
  SEX_LABELS,
  SEX_TO_FHIR_GENDER,
  VITAL_SIGNS,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import {
  clinicalNote,
  diagnosisCatalog,
  encounter,
  encounterDiagnosis,
  encounterProcedure,
  imagingStudy,
  imagingStudyFile,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientDocument,
  patientFamilyHistory,
  patientMedication,
  prescription,
  prescriptionItem,
} from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { type DeclaredHealthGroup, getPatientHealth, type HealthDeclaration } from "./clinical.js"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { type DataRequestItem, listDataRequests, respondDataRequest } from "./data-requests.js"
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
import { type FormRecord, type FormRecordItem, loadFormRecords } from "./form-record.js"
import { proposeHealthChannel } from "./health-documents.js"
import { clinicToday } from "./inventory-stock.js"
import { getPatient, requirePatient } from "./patients.js"
import { listPlanItems } from "./plan.js"
import type { ExamObservation, RecordSection, SiteColumns } from "./product-hooks.js"
import { productHooks } from "./products.js"
import { listDecisionRecipients } from "./responsibilities.js"

/** La pieza y las caras de un diagnóstico o procedimiento, sacadas de su sitio. */
/** El sitio dicho por el producto: en palabras para el PDF y como `bodySite` para FHIR. */
type RecordSite = { siteWords: string | null; bodySite: { text: string } | null }

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
  }
  contacts: Array<{
    contactId: string
    displayName: string
    relationship: string
    detail: string | null
    phone: string | null
  }>
  allergies: Array<typeof patientAllergy.$inferSelect>
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
    "allergies" | "conditions" | "medications",
    { state: string; saidNo: { by: HealthDeclarant; at: Date } | null }
  >
  /**
   * Lo que alguien dijo de su salud y ningún profesional revisó todavía, por
   * declaración: quién, cuándo y qué. Lo decide el servidor (`PatientHealth.declared`),
   * igual que para la ficha.
   */
  declared: DeclaredHealthGroup[]
  /**
   * Lo que declaró de su salud, tal como llegó, de lo más antiguo a lo más nuevo. Lo
   * que dijo en un formulario no se repite aquí: va con su formulario.
   */
  declarations: RecordDeclaration[]
  /** null si no hay nada que contar: nunca se guardó una entrevista, o la vigente quedó sin datos. */
  interview: RecordInterview | null
  familyHistory: Array<typeof patientFamilyHistory.$inferSelect>
  encounters: Array<{
    row: typeof encounter.$inferSelect
    diagnoses: Array<typeof encounterDiagnosis.$inferSelect & RecordSite & { title: string | null }>
    procedures: Array<typeof encounterProcedure.$inferSelect & RecordSite>
    /** El examen como lo cuenta el producto: en líneas para el PDF y como Observations para FHIR. */
    exam: { lines: string[]; observations: ExamObservation[] }
    /** Lo corregido después de firmar, con quién y cuándo: también es parte de la historia. */
    addenda: Array<{ note: string; authorName: string | null; createdAt: Date }>
  }>
  /** Lo que agrega el producto de la clínica (odentIA: el odontograma vigente). */
  productSections: RecordSection[]
  planItems: Array<{ title: string; status: string; siteWords: string | null }>
  prescriptions: Array<{
    row: typeof prescription.$inferSelect
    items: Array<typeof prescriptionItem.$inferSelect>
  }>
  consents: Array<typeof consentDocument.$inferSelect>
  /**
   * Las fichas finalizadas y lo que respondió la persona, revisado o no, con cada
   * pregunta, su respuesta y sus adendas o correcciones.
   */
  forms: FormRecord[]
  documents: Array<typeof patientDocument.$inferSelect>
  appointments: Array<typeof appointment.$inferSelect>
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
 * Lo que trae una declaración, como lo respondió: sus alergias, enfermedades y
 * medicinas, el grupo sanguíneo, el embarazo con las semanas que dijo y lo demás
 * de la entrevista, que cuenta el producto (`interviewEntries`).
 */
function declarationEntries(
  health: HealthDeclaration["health"],
  interviewEntries: InterviewEntry[],
): InterviewEntry[] {
  const out: InterviewEntry[] = []
  const add = (key: string, label: string, value: string | null) => {
    if (value) out.push({ key, label, value })
  }
  add(
    "allergies",
    "Alergias",
    declaredGroupWords(health.allergies, (item) => {
      const severity = textOf(item.severity)
      return `${joined(textOf(item.substance), textOf(item.reaction))}${severity && severity !== "desconocida" ? ` (${severity})` : ""}`
    }),
  )
  add("conditions", "Enfermedades", declaredGroupWords(health.conditions, (item) => joined(textOf(item.name), textOf(item.notes))))
  add(
    "medications",
    "Medicación",
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
          : {}),
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
  const diagnoses = encounterIds.length
    ? await tx
        .select()
        .from(encounterDiagnosis)
        .where(and(byPatient(encounterDiagnosis), isNull(encounterDiagnosis.voidedAt)))
        .orderBy(asc(encounterDiagnosis.createdAt))
    : []
  const addenda = encounterIds.length
    ? await tx
        .select({ encounterId: clinicalNote.encounterId, note: clinicalNote.note, authorName: user.name, createdAt: clinicalNote.createdAt })
        .from(clinicalNote)
        .leftJoin(user, eq(user.id, clinicalNote.authorUserId))
        .where(
          and(
            eq(clinicalNote.organizationId, orgId),
            inArray(clinicalNote.encounterId, encounterIds),
            eq(clinicalNote.kind, "adenda"),
          ),
        )
        .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id))
    : []
  const procedures = encounterIds.length
    ? await tx
        .select()
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.encounterId, encounterIds),
            isNull(encounterProcedure.voidedAt),
          ),
        )
        .orderBy(asc(encounterProcedure.createdAt))
    : []
  const titles = new Map<string, string>()
  const codes = [...new Set(diagnoses.map((d) => d.diagnosisCode))]
  if (codes.length) {
    const found = await tx
      .select({
        system: diagnosisCatalog.systemKey,
        code: diagnosisCatalog.code,
        title: diagnosisCatalog.title,
      })
      .from(diagnosisCatalog)
      .where(inArray(diagnosisCatalog.code, codes))
    for (const row of found) titles.set(`${row.system}|${row.code}`, row.title)
  }
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
  const documents = await tx
    .select()
    .from(patientDocument)
    .where(and(byPatient(patientDocument), isNull(patientDocument.retiredAt)))
    // Por su fecha (la de toma, en una imagen), como en la Historia; sin ella, la de subida.
    .orderBy(asc(sql`coalesce(${patientDocument.capturedAt}, ${patientDocument.createdAt})`), asc(patientDocument.createdAt))
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
  const saidNoOf = (topic: "allergies" | "conditions" | "medications") => {
    const last = health.declarations.find((declaration) => {
      const state = declaration.health[topic]?.state
      return state !== undefined && state !== "unanswered"
    })
    return last && last.health[topic]?.state === "none" ? { by: last.by, at: last.at } : null
  }
  // Un embarazo guardado antes, sin fecha, toma la del día en que se anotó ese «sí»: lo calcula la
  // ficha (`getPatientHealth`), y la copia usa el mismo día.
  const legacySaidOn = health.pregnancy?.saidOn ?? null
  const planItems = await listPlanItems(tx, orgId, patientId)
  const site = hooks.site
  const recordSite = (row: SiteColumns): RecordSite => ({
    siteWords: site.words(row),
    bodySite: site.bodySite(row),
  })
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
    },
    contacts: full.contacts
      .filter((c) => c.relationship !== "self")
      .map((c) => ({
        contactId: c.contactId,
        displayName: c.displayName,
        relationship: c.relationship,
        detail: c.relationshipDetail,
        phone: c.phone,
      })),
    allergies,
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
    declarations: health.declarations
      .filter((declaration) => declaration.via !== "formulario")
      .map((declaration) => {
        const day = clinicDay(declaration.at, establishmentRow?.timezone || "UTC")
        return {
          at: declaration.at,
          via: declaration.via,
          by: declaration.by,
          entries: declarationEntries(
            declaration.health,
            // Lo de la entrevista, como lo cuenta el producto, con las claves con que entró ese día.
            hooks.interview.record(hooks.interview.declared(declaration.health, day), day),
          ),
        }
      })
      .reverse(),
    interview: interviewOf(
      interviewVersions,
      (answers, current, shownDay) => hooks.interview.record(answers, today, current ? { legacySaidOn, shownDay } : {}),
      health,
      (at) => clinicDay(at, establishmentRow?.timezone || "UTC"),
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
      procedures: procedures
        .filter((p) => p.encounterId === row.id)
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
    planItems: planItems.map((item) => ({
      title: item.title,
      status: item.status,
      siteWords: site.words(item, "short"),
    })),
    prescriptions: prescriptions.map((row) => ({
      row,
      items: items.filter((i) => i.prescriptionId === row.id),
    })),
    consents,
    forms,
    documents,
    appointments,
  }
}

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

/** «en_curso» → «en curso»: el estado del tratamiento en palabras. */
function planStatusWords(status: string): string {
  return status.replaceAll("_", " ")
}

const CONSENT_WORDS: Record<string, string> = {
  pendiente: "pendiente",
  firmado: "firmado",
  revocado: "revocado",
  anulado: "anulado",
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

/** Lo que acompaña a un dato de la entrevista: que sigue sin revisar, o de qué versión anterior viene. */
function entryNote(entry: RecordInterview["entries"][number], sex: string | null, zone: Zone): string | null {
  if (entry.unreviewed) return entry.unreviewed.repeatsVersion ? "sin revisar" : unreviewedWords(entry.unreviewed, sex, zone)
  return entry.since ? saidWords(entry.since, sex, zone) : null
}

/** De qué declaración sin revisar es una alergia, una enfermedad o una medicina; undefined si ya se revisó o la anotó el equipo. */
function declaredGroupOf(
  record: PatientRecord,
  topic: "allergies" | "conditions" | "medications",
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

type HealthTopic = "allergies" | "conditions" | "medications"

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

/** «Ya no lo toma (hasta el 10/11/2026)»: la que no es vigente con la regla común (`isCurrentMedication`). */
const medicationEnded = (row: { endDate: string | null }, today: string): boolean => !isCurrentMedication(row, today)

/** «13/11/2026»: un día de calendario, igual en cualquier zona. */
const civilDayWords = (day: string): string => day.split("-").reverse().join("/")

/** El PDF para leer: todo lo de la persona, en el estilo de sus recetas y consentimientos. */
export async function renderPatientRecordPdf(
  record: PatientRecord,
  clinic: DocumentClinic,
): Promise<Uint8Array> {
  const zone = clinic
  const p = record.person
  const chart = chartNumber(p.patientNumber)
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), {
    title: "Historia clínica",
    docLabel: "Historia clínica",
    patientLabel: `${p.displayName} · ${chart}`,
    legalNote: `Copia entregada por ${clinic.tradeName || "la clínica"} a pedido de la persona.`,
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
  if (record.contacts.length)
    kit.bullets(
      record.contacts.map(
        (c) =>
          `${c.displayName} · ${c.detail ?? RELATION_WORDS[c.relationship] ?? c.relationship}${c.phone ? ` · ${c.phone}` : ""}`,
      ),
    )

  section("Alergias y antecedentes")
  // Lo que dijo la persona y nadie revisó va marcado, con quién lo dijo y cuándo, como en la ficha.
  const markOf = (topic: "allergies" | "conditions" | "medications", id: string): string | null => {
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
  // Un grupo sin nada anotado dice cómo quedó: «niega» si el equipo lo preguntó; tras una revisión,
  // «no se le preguntó», con el «no» que ella dijo, que no se pierde (auditor, QA de la entrega 2).
  const groupLines = (
    [
      ["allergies", "Alergias", record.allergies.length],
      ["conditions", "Enfermedades", record.conditions.length],
      ["medications", "Medicación", record.medications.length],
    ] as const
  ).flatMap(([topic, label, rows]) => {
    if (rows > 0 || record.declared.some((group) => group.saidNo[topic])) return []
    const group = record.groups[topic]
    if (group.state === "none") return [`${label}: niega`]
    if (group.state !== "unknown" || !record.reviews.history) return []
    const said = group.saidNo
      ? `; ${saidNoWords(group.saidNo.by, p.sex).replace(/^./, (letter) => letter.toLocaleLowerCase("es"))} el ${dayWords(group.saidNo.at, zone)}`
      : ""
    return [`${label}: no se le preguntó en la clínica${said}`]
  })
  if (
    !record.allergies.length &&
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
  if (record.conditions.length)
    kit.bullets(
      record.conditions.map(
        (c) =>
          `Antecedente: ${c.name} · ${c.status}${c.diagnosisCode ? ` · ${c.diagnosisCode}` : ""}${markOf("conditions", c.id) ? ` · ${markOf("conditions", c.id)}` : ""}`,
      ),
    )
  // La que ya no toma no se lee como vigente: dice hasta cuándo y su nota, como el FHIR
  // (`completed`) y la franja de la ficha, que ya no la muestra (QA de la entrega 2).
  if (record.medications.length)
    kit.bullets(
      record.medications.map((m) => {
        const ended = medicationEnded(m, record.today)
        const until = m.endDate ? ` · hasta el ${civilDayWords(m.endDate)}` : ""
        const mark = markOf("medications", m.id)
        return `${ended ? "Ya no lo toma" : "Medicamento"}: ${m.name}${m.dose ? ` · ${m.dose}` : ""}${m.frequency ? ` · ${m.frequency}` : ""}${until}${m.notes ? ` · ${m.notes}` : ""}${mark ? ` · ${mark}` : ""}`
      }),
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
      kit.text(DECLARATION_VIA_WORDS[declaration.via], { face: "sansBold", size: SIZE.table })
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

  section(`Atenciones (${record.encounters.length})`)
  if (!record.encounters.length) kit.text("Sin atenciones registradas.")
  for (const { row, diagnoses, procedures, exam, addenda } of record.encounters) {
    const vitals = (row.vitals ?? {}) as Record<string, unknown>
    const vitalText = VITAL_SIGNS.filter((v) => typeof vitals[v.key] === "number")
      .map((v) => `${v.label} ${vitals[v.key]} ${v.suffix}`)
      .join(" · ")
    kit.ensure(50)
    kit.gap(5)
    kit.rule()
    kit.gap(7)
    const signer = [row.signerName, row.signerRegistration].filter(Boolean).join(" · ")
    kit.spread(
      {
        text: `${dayTimeWords(row.startedAt, zone)}${row.status === "finalizada" ? "" : ` · ${ENCOUNTER_WORDS[row.status] ?? row.status}`}`,
        face: "sansBold",
        size: SIZE.read,
      },
      { text: signer, size: SIZE.second, tone: "gray" },
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
      ["Diagnóstico", diagnoses.map((d) => `${diagnosisText(d)}${siteText(d)}`)],
      ["Se hizo", procedures.map((pr) => `${pr.description}${siteText(pr)}`)],
      // Lo que se anotó en una ficha durante la atención, o lo que respondió para ella; sus
      // respuestas van en su apartado.
      [
        "Fichas",
        record.forms
          .filter((form) => form.encounterId === row.id)
          .map((form) => `${form.title} (ver «${FORM_SECTION_WORDS[form.source]}»)`),
      ],
      ["Evolución", row.evolution],
      ["Plan", row.indications],
      ["Anulada", row.status === "anulada" ? row.voidReason : null],
      // Con el nombre de la pantalla: «Correcciones después del cierre» (QA de la entrega 2).
      [
        "Correcciones después del cierre",
        addenda.map((a) => `${a.note} (${[a.authorName, dayTimeWords(a.createdAt, zone)].filter(Boolean).join(", ")})`),
      ],
    ])
  }

  for (const product of record.productSections) {
    section(product.title)
    if (!product.lines.length) kit.text(product.empty)
    else kit.bullets(product.lines)
  }

  section("Plan de tratamiento")
  if (!record.planItems.length) kit.text("Sin tratamientos en el plan.")
  else
    kit.bullets(
      record.planItems.map(
        (i) => `${i.title}${i.siteWords ? ` · ${i.siteWords}` : ""} · ${planStatusWords(i.status)}`,
      ),
    )

  section("Recetas")
  if (!record.prescriptions.length) kit.text("Sin recetas.")
  for (const { row, items } of record.prescriptions) {
    kit.text(
      `Receta N.º ${row.prescriptionNumber} · ${dayTimeWords(row.issuedAt, zone)}${row.status === "anulada" ? " · anulada" : ""}`,
      {
        face: "sansSemi",
      },
    )
    kit.bullets(
      items.map(
        (i) =>
          `${i.medicationName}${i.strength ? ` ${i.strength}` : ""}${i.dose ? ` · ${i.dose}` : ""}${i.frequency ? ` · ${i.frequency}` : ""}${i.duration ? ` · ${i.duration}` : ""}`,
      ),
    )
  }

  section("Consentimientos")
  if (!record.consents.length) kit.text("Sin consentimientos.")
  else
    kit.bullets(
      record.consents.map(
        (c) =>
          `${c.titleSnapshot} · ${CONSENT_WORDS[c.status] ?? c.status}${
            c.status === "revocado" && c.revokedAt
              ? ` el ${dayTimeWords(c.revokedAt, zone)}`
              : c.signedAt
                ? ` el ${dayTimeWords(c.signedAt, zone)}`
                : ""
          }${c.pdfSha256 ? ` · huella ${c.pdfSha256.slice(0, 16)}…` : ""}`,
      ),
    )

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
          group.items.map((item) => [item.label, item.words ?? (source === "portal" ? "No respondió" : "Sin respuesta")]),
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
    kit.text("Los archivos van aparte, en la carpeta «documentos» del ZIP.", {
      size: SIZE.second,
      tone: "gray",
    })
    kit.bullets(
      record.documents.map((d) => `${d.label} · ${documentDateWords(d, zone)}`),
    )
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
}

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
  const patientRef = { reference: `Patient/${p.patientId}` }
  const resources: Resource[] = []
  const docCode = hl7DocumentTypeCode(p.docType, p.docCountry)
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
    telecom: [
      ...(p.phone ? [{ system: "phone", value: p.phone }] : []),
      ...(p.email ? [{ system: "email", value: p.email }] : []),
    ],
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
    topic: "allergies" | "conditions" | "medications",
    id: string,
    field: "asserter" | "informationSource",
  ): Record<string, unknown> => {
    const group = declaredGroupOf(record, topic, id)
    if (!group) return {}
    const who = asserterOf(group.by, patientRef)
    return { ...(who ? { [field]: who } : {}), note: [{ text: unreviewedWords(group, p.sex, record.clinic) }] }
  }
  for (const a of record.allergies) {
    const category = fhirCode(ALLERGY_CATEGORY_FHIR, a.category)
    const severity = fhirCode(ALLERGY_SEVERITY_FHIR, a.severity)
    resources.push({
      resourceType: "AllergyIntolerance",
      id: a.id,
      patient: patientRef,
      clinicalStatus: { coding: [{ system: FHIR_ALLERGY_CLINICAL_SYSTEM, code: "active" }] },
      verificationStatus: {
        coding: [
          {
            system: FHIR_ALLERGY_VERIFICATION_SYSTEM,
            code: fhirCode(ALLERGY_VERIFICATION_FHIR, a.verification) ?? "unconfirmed",
          },
        ],
      },
      type: fhirCode(ALLERGY_TYPE_FHIR, a.kind) ?? "allergy",
      ...(category ? { category: [category] } : {}),
      ...(fhirCode(ALLERGY_CRITICALITY_FHIR, a.criticality)
        ? { criticality: fhirCode(ALLERGY_CRITICALITY_FHIR, a.criticality) }
        : {}),
      code: { text: a.substance },
      ...statedBy("allergies", a.id, "asserter"),
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
      ...(declaredGroupOf(record, "conditions", c.id)
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
      status: medicationEnded(m, record.today) ? "completed" : "active",
      medicationCodeableConcept: { text: m.name },
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
  for (const { row, diagnoses, procedures, exam } of record.encounters) {
    const encounterRef = { reference: `Encounter/${row.id}` }
    // Lo observado vale como la atención: definitivo solo si se firmó, en curso si no, y
    // anulado si se anuló (como sus procedimientos). Un borrador no viaja como «final».
    const observationStatus =
      row.status === "anulada" ? "entered-in-error" : row.status === "finalizada" ? "final" : "preliminary"
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
      period: {
        start: row.startedAt.toISOString(),
        ...(row.endedAt ? { end: row.endedAt.toISOString() } : {}),
      },
      ...(row.reason ? { reasonCode: [{ text: row.reason }] } : {}),
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
  for (const { row, items } of record.prescriptions)
    for (const item of items)
      resources.push({
        resourceType: "MedicationRequest",
        id: item.id,
        status: fhirCode(PRESCRIPTION_STATUS_FHIR, row.status) ?? "unknown",
        intent: "order",
        subject: patientRef,
        ...(row.encounterId ? { encounter: { reference: `Encounter/${row.encounterId}` } } : {}),
        authoredOn: row.issuedAt.toISOString(),
        medicationCodeableConcept: {
          ...(item.atcCode
            ? { coding: [{ system: "http://www.whocc.no/atc", code: item.atcCode }] }
            : {}),
          text: [item.medicationName, item.strength].filter(Boolean).join(" "),
        },
        dosageInstruction: [
          {
            text: [item.dose, item.route, item.frequency, item.duration, item.instructions]
              .filter(Boolean)
              .join(" · "),
          },
        ],
      })
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
  for (const c of record.consents)
    resources.push({
      resourceType: "Consent",
      id: c.id,
      status: fhirCode(CONSENT_STATUS_FHIR, c.status) ?? "proposed",
      scope: { coding: [FHIR_CONSENT_SCOPE] },
      category: [{ coding: [FHIR_CONSENT_CATEGORY] }],
      patient: patientRef,
      ...(c.signedAt ? { dateTime: c.signedAt.toISOString() } : {}),
      policyRule: { text: c.titleSnapshot },
    })
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
    const authored =
      (form.source === "portal" ? form.submittedAt : null) ?? form.finalizedAt ?? form.submittedAt ?? record.generatedAt
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
  record.declarations.forEach((declaration, index) => {
    if (declaration.entries.length === 0) return
    resources.push(
      questionnaireResponse({
        id: `${p.patientId}-declaracion-${index + 1}`,
        title: "Declaración de salud",
        authored: declaration.at,
        patientRef,
        source: asserterOf(declaration.by, patientRef),
        groups: [
          {
            linkId: "declaracion",
            text: DECLARATION_VIA_WORDS[declaration.via],
            items: declaration.entries.map((entry) => ({
              linkId: entry.key,
              text: entry.label,
              type: "string",
              answers: [{ valueString: entry.value }],
            })),
          },
        ],
        notes: [
          `${DECLARATION_VIA_WORDS[declaration.via]}. ${saidWhenWords(declaration.by, dayTimeWords(declaration.at, record.clinic), p.sex)}.`,
        ],
      }),
    )
  })
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
  for (const d of record.documents)
    resources.push({
      resourceType: "DocumentReference",
      id: d.id,
      status: "current",
      type: { text: d.label },
      category: [{ text: d.category }],
      subject: patientRef,
      date: d.createdAt.toISOString(),
      content: [
        {
          attachment: {
            contentType: d.contentType,
            title: d.label,
            url: `documentos/${documentFileName(d)}`,
            // FHIR R4 Attachment.creation: cuándo se hizo el papel (o se tomó la imagen);
            // `date` es cuándo entró a la ficha.
            // Solo el día (FHIR admite fecha sola): un día elegido no tiene hora.
            ...(d.capturedAt ? { creation: clinicDay(d.capturedAt, record.clinic.timezone) } : {}),
          },
        },
      ],
    })
  return {
    resourceType: "Bundle",
    type: "collection",
    meta: { tag: [{ system: "https://odentia32.com/fhir", code: `fhir-${FHIR_VERSION}` }] },
    timestamp: record.generatedAt.toISOString(),
    // R4 pide que `fullUrl` sea una dirección absoluta, y un `urn:uuid` lleva un UUID: el id que no lo
    // es (`…-entrevista`, `…-examen-abdomen`) va con un UUID v5 suyo, que no tiene por qué ser su id
    // cuando es un `urn:uuid` (Bundle.entry.fullUrl). Así no se arma un `urn:uuid` que no lo es
    // (revisor, QA de la entrega 2) ni un `fullUrl` relativo.
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${UUID_RE.test(resource.id) ? resource.id : uuidV5(p.patientId, `${resource.resourceType}/${resource.id}`)}`,
      resource,
    })),
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
  const { channels: all } = await documentChannelsFor(tx, orgId, recipient)
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
 * comprobado que es ella; un pedido ya respondido no se envía otra vez.
 */
export async function sendPatientRecordCopy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  requestId: string,
  input: { connectionId: string },
  deps: SendDeps,
): Promise<{ request: DataRequestItem; conversationId: string; channel: string }> {
  const request = await copyRequest(tx, orgId, patientId, requestId)
  if (request.status !== "pendiente")
    throw new ServiceError("DATA_REQUEST_CLOSED", 409, "Este pedido ya se respondió")
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
  const record = await loadPatientRecord(tx, orgId, patientId)
  const pdf = await renderPatientRecordPdf(record, record.clinic)
  const clinic = record.clinic.tradeName
  const { conversationId, messageId } = await deliverDocumentPdf(
    tx,
    orgId,
    actorUserId,
    {
      recipient,
      conn,
      pdf,
      filename: patientRecordFileName(record, "pdf"),
      // La primera línea es el asunto del correo en frío.
      caption: `Copia de tu historia${clinic ? ` · ${clinic}` : ""}\n\nAquí tienes la copia de tu historia que pediste.`,
    },
    deps,
  )
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient_record.sent",
    entity: "message",
    entityId: messageId,
    metadata: { patientId, requestId, conversationId, channel: conn.channel },
  })
  const responded = await respondDataRequest(tx, orgId, actorUserId, patientId, requestId, {
    resolution: `Se le envió por ${CHANNEL_WORDS[conn.channel] ?? conn.channel} el PDF de su historia.`,
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
