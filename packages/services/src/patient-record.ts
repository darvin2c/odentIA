/**
 * La historia completa de una persona, para entregársela (issue 45 mínimo,
 * ADR 0080): un PDF para leer y un paquete HL7 FHIR R4 para que otra clínica
 * la cargue. Las imágenes y documentos van aparte, en el ZIP de la API.
 *
 * Lee todo lo clínico de la persona: solo la piden quienes leen la ficha
 * clínica (`clinical.read`). El envío a la propia persona lo hace el servidor
 * sin mostrarla a quien lo pide (Recepción).
 */
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
  FHIR_LOINC_SYSTEM,
  FHIR_OBSERVATION_CATEGORY_SYSTEM,
  FHIR_OBSERVATION_INTERPRETATION_SYSTEM,
  FHIR_ROLE_CODE_SYSTEM,
  FHIR_UCUM_SYSTEM,
  FHIR_VERSION,
  FORM_FIELD_TYPE_FHIR,
  fhirCode,
  HL7_IDENTIFIER_TYPE_SYSTEM,
  hl7DocumentTypeCode,
  type InterviewEntry,
  isDiagnosisSystem,
  isImageDocumentCategory,
  KINSHIP_LABELS,
  PRESCRIPTION_STATUS_FHIR,
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
 * La «Entrevista de salud» vigente como la cuenta el producto (`ProductInterview.record`),
 * con quién la guardó y cuándo. Lo que viene igual desde una versión anterior dice
 * desde cuál: así lo que la persona declaró se sigue leyendo como suyo aunque el
 * equipo haya guardado después otra versión.
 */
export interface RecordInterview {
  version: number
  recordedAt: Date
  /** Quién la guardó; null si no hay quién (la declaró la persona). */
  recordedBy: string | null
  /** La declaró la persona o quien la representa (registro o enlace), no el equipo. */
  declared: boolean
  entries: Array<InterviewEntry & { since: { at: Date; by: string | null; declared: boolean } | null }>
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
  /** Los formularios finalizados, con cada pregunta, su respuesta y sus adendas. */
  forms: FormRecord[]
  documents: Array<typeof patientDocument.$inferSelect>
  appointments: Array<typeof appointment.$inferSelect>
}

/** La entrevista vigente y, de cada dato, desde qué versión consta igual. */
function interviewOf(
  versions: Array<{ version: number; answers: unknown; createdAt: Date; createdBy: string | null; authorName: string | null }>,
  entriesOf: (answers: unknown) => InterviewEntry[],
): RecordInterview | null {
  const latest = versions.at(-1)
  const current = latest ? entriesOf(latest.answers) : []
  // Sin ningún dato vigente no hay entrevista que mostrar: un encabezado solo, con quién y cuándo, no dice nada.
  if (!latest || current.length === 0) return null
  const told = versions.map((row) => new Map(entriesOf(row.answers).map((entry) => [entry.key, entry.value])))
  return {
    version: latest.version,
    recordedAt: latest.createdAt,
    recordedBy: latest.authorName,
    declared: latest.createdBy === null,
    entries: current.map((entry) => {
      let first = versions.length - 1
      while (first > 0 && told[first - 1]?.get(entry.key) === entry.value) first -= 1
      const from = versions[first]
      return {
        ...entry,
        since: from && from !== latest ? { at: from.createdAt, by: from.authorName, declared: from.createdBy === null } : null,
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
  const familyHistory = await tx
    .select()
    .from(patientFamilyHistory)
    .where(byPatient(patientFamilyHistory))
    .orderBy(asc(patientFamilyHistory.createdAt))
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
  const forms = await loadFormRecords(tx, orgId, patientId)
  const hooks = await productHooks(tx, orgId)
  const productSections = await hooks.recordSections(tx, { orgId, patientId })
  const today = await clinicToday(tx, orgId)
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
    // Cada producto cuenta su entrevista (odentIA: lo de la boca; latidIA: embarazo y lactancia con fecha).
    interview: interviewOf(interviewVersions, (answers) => hooks.interview.record(answers, today)),
    familyHistory,
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

/** «Registrada por Ana Torres el 13 de noviembre de 2026, 15:02»: de quién es la entrevista vigente. */
function interviewWords(interview: RecordInterview, zone: Zone): string {
  const who = interview.declared
    ? "Declarada por el paciente o su responsable"
    : `Registrada por ${interview.recordedBy ?? "el equipo"}`
  return `${who} el ${dayTimeWords(interview.recordedAt, zone)}`
}

/** Desde cuándo consta un dato que viene igual de una versión anterior, y si lo declaró la persona. */
function sinceWords(since: NonNullable<RecordInterview["entries"][number]["since"]>, zone: Zone): string {
  if (since.declared) return `Lo declaró el paciente o su responsable el ${dayWords(since.at, zone)}`
  return `Consta desde el ${dayWords(since.at, zone)}${since.by ? `, lo registró ${since.by}` : ""}`
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

/** «La prueba se repitió (Ana Torres, 13 de noviembre de 2026, 15:20)»: la adenda con quién y cuándo. */
function addendumWords(addendum: FormRecord["addenda"][number], zone: Zone): string {
  return `${addendum.text} (${[addendum.authorName, dayTimeWords(addendum.createdAt, zone)].filter(Boolean).join(", ")})`
}

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
  const section = (title: string) =>
    kit.heading(title, { size: SIZE.h2small, before: 18, after: 5 })
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
  if (!record.allergies.length && !record.conditions.length && !record.medications.length)
    kit.text("Sin registros.")
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
          `Antecedente: ${c.name} · ${c.status}${c.diagnosisCode ? ` · ${c.diagnosisCode}` : ""}`,
      ),
    )
  if (record.medications.length)
    kit.bullets(
      record.medications.map(
        (m) =>
          `Medicamento: ${m.name}${m.dose ? ` · ${m.dose}` : ""}${m.frequency ? ` · ${m.frequency}` : ""}`,
      ),
    )

  section("Entrevista de salud")
  if (!record.interview && !record.familyHistory.length) kit.text("Sin entrevista de salud registrada.")
  if (record.interview) {
    kit.text(`Versión ${record.interview.version} · ${interviewWords(record.interview, zone)}`, {
      size: SIZE.second,
      tone: "gray",
    })
    dataRows(
      record.interview.entries.map((entry) => [
        entry.label,
        [
          entry.since
            ? [entry.value, { text: ` · ${sinceWords(entry.since, zone)}`, tone: "gray" as const }]
            : entry.value,
        ],
      ]),
      140,
    )
  }
  dataRows([["Antecedentes familiares", record.familyHistory.map(familyWords)]], 140)

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
      // Lo que se anotó en un formulario durante la atención; sus respuestas van en «Formularios».
      [
        "Formularios",
        record.forms.filter((form) => form.encounterId === row.id).map((form) => `${form.title} (ver «Formularios»)`),
      ],
      ["Evolución", row.evolution],
      ["Plan", row.indications],
      ["Anulada", row.status === "anulada" ? row.voidReason : null],
      [
        "Adendas",
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

  section(`Formularios (${record.forms.length})`)
  if (!record.forms.length) kit.text("Sin formularios finalizados.")
  for (const form of record.forms) {
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
    for (const group of form.sections) {
      if (group.title) kit.subheading(group.title)
      dataRows(
        group.items.map((item) => [item.label, item.words ?? "Sin respuesta"]),
        190,
      )
    }
    // Lo corregido después de finalizar no cambia las respuestas: va aparte, con quién y cuándo.
    if (form.addenda.length) {
      kit.subheading("Adendas")
      kit.bullets(form.addenda.map((addendum) => addendumWords(addendum, zone)))
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
  version: number
  authored: Date
  patientRef: { reference: string }
  encounterId?: string | null
  /** Quien anotó las respuestas. */
  author?: Record<string, unknown> | null
  /** Quien las dio, si las respondió la persona. */
  source?: Record<string, unknown> | null
  groups: Array<{ linkId: string; text: string; items: AskedItem[] }>
  notes: string[]
}): Resource {
  const lines = [`${input.title} · versión ${input.version}`, ...input.notes]
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
        version: String(input.version),
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
    status: "completed",
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
      // El id de la persona vinculada: en la copia de un paciente es única, y cabe en los 64
      // caracteres de un id de FHIR (con el del paciente delante eran 73).
      id: c.contactId,
      patient: patientRef,
      name: [{ text: c.displayName }],
      relationship: [{ text: c.detail ?? c.relationship }],
      ...(c.phone ? { telecom: [{ system: "phone", value: c.phone }] } : {}),
    })
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
      category: [{ text: "Antecedente" }],
      code: diagnosisCodeable(c.diagnosisSystem, c.diagnosisCode, c.name),
      ...(c.startDate ? { onsetDateTime: c.startDate } : {}),
    })
  for (const m of record.medications)
    resources.push({
      resourceType: "MedicationStatement",
      id: m.id,
      subject: patientRef,
      status: m.endDate ? "completed" : "active",
      medicationCodeableConcept: { text: m.name },
      ...(m.dose || m.frequency
        ? { dosage: [{ text: [m.dose, m.frequency].filter(Boolean).join(" · ") }] }
        : {}),
    })
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
  // Los formularios finalizados: lo que anotó el equipo y lo que respondió la persona y se revisó.
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
            ? { reference: `RelatedPerson/${related.contactId}`, display: related.displayName }
            : form.filledBy
              ? { display: form.filledBy }
              : null
    resources.push(
      questionnaireResponse({
        id: form.id,
        title: form.title,
        version: form.version,
        authored: form.finalizedAt,
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
          ...form.addenda.map((addendum) => `Adenda: ${addendumWords(addendum, record.clinic)}`),
        ],
      }),
    )
  }
  // La entrevista de salud vigente, como la cuenta el producto: cada dato en palabras.
  if (record.interview)
    resources.push(
      questionnaireResponse({
        id: `${p.patientId}-entrevista`,
        title: "Entrevista de salud",
        version: record.interview.version,
        authored: record.interview.recordedAt,
        patientRef,
        author: record.interview.recordedBy ? { display: record.interview.recordedBy } : null,
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
          interviewWords(record.interview, record.clinic),
          ...record.interview.entries.flatMap((entry) =>
            entry.since ? [`${entry.label}: ${sinceWords(entry.since, record.clinic)}`] : [],
          ),
        ],
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
    entry: resources.map((resource) => ({ fullUrl: `urn:uuid:${resource.id}`, resource })),
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
