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
  FHIR_UCUM_SYSTEM,
  FHIR_VERSION,
  fhirCode,
  HL7_IDENTIFIER_TYPE_SYSTEM,
  hl7DocumentTypeCode,
  isDiagnosisSystem,
  PRESCRIPTION_STATUS_FHIR,
  SEX_LABELS,
  SEX_TO_FHIR_GENDER,
  VITAL_SIGNS,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  diagnosisCatalog,
  encounter,
  encounterDiagnosis,
  encounterProcedure,
  imagingStudy,
  imagingStudyFile,
  patientAllergy,
  patientCondition,
  patientDocument,
  patientMedication,
  prescription,
  prescriptionItem,
} from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import type { ExamObservation, RecordSection, SiteColumns } from "./product-hooks.js"
import { productHooks } from "./products.js"
import { type DataRequestItem, listDataRequests, respondDataRequest } from "./data-requests.js"
import { notFound, ServiceError, validation } from "./errors.js"
import {
  deliverDocumentPdf,
  type DocumentChannelOption,
  documentChannelsFor,
  requireDocumentConnection,
  type SendDeps,
} from "./financial-documents.js"
import { type Establishment, header, newWriter, patientLine, proposeHealthChannel, zoneOf } from "./health-documents.js"
import { listPlanItems } from "./plan.js"
import { getPatient, requirePatient } from "./patients.js"
import { MUTED, when } from "./pdf-writer.js"
import { listDecisionRecipients } from "./responsibilities.js"

/** La pieza y las caras de un diagnóstico o procedimiento, sacadas de su sitio. */
/** El sitio dicho por el producto: en palabras para el PDF y como `bodySite` para FHIR. */
type RecordSite = { siteWords: string | null; bodySite: { text: string } | null }

export interface PatientRecord {
  generatedAt: Date
  establishment: Establishment | null
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
  contacts: Array<{ contactId: string; displayName: string; relationship: string; detail: string | null; phone: string | null }>
  allergies: Array<typeof patientAllergy.$inferSelect>
  conditions: Array<typeof patientCondition.$inferSelect>
  medications: Array<typeof patientMedication.$inferSelect>
  encounters: Array<{
    row: typeof encounter.$inferSelect
    diagnoses: Array<typeof encounterDiagnosis.$inferSelect & RecordSite & { title: string | null }>
    procedures: Array<typeof encounterProcedure.$inferSelect & RecordSite>
    /** El examen como lo cuenta el producto: en líneas para el PDF y como Observations para FHIR. */
    exam: { lines: string[]; observations: ExamObservation[] }
  }>
  /** Lo que agrega el producto de la clínica (odentIA: el odontograma vigente). */
  productSections: RecordSection[]
  planItems: Array<{ title: string; status: string; siteWords: string | null }>
  prescriptions: Array<{ row: typeof prescription.$inferSelect; items: Array<typeof prescriptionItem.$inferSelect> }>
  consents: Array<typeof consentDocument.$inferSelect>
  documents: Array<typeof patientDocument.$inferSelect>
  appointments: Array<typeof appointment.$inferSelect>
}

/** Todo lo de la persona, de su clínica, en orden cronológico. */
export async function loadPatientRecord(tx: Db, orgId: string, patientId: string): Promise<PatientRecord> {
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
  const conditions = await tx.select().from(patientCondition).where(byPatient(patientCondition)).orderBy(asc(patientCondition.createdAt))
  const medications = await tx.select().from(patientMedication).where(byPatient(patientMedication)).orderBy(asc(patientMedication.createdAt))
  const encounters = await tx.select().from(encounter).where(byPatient(encounter)).orderBy(asc(encounter.startedAt))
  const encounterIds = encounters.map((e) => e.id)
  const diagnoses = encounterIds.length
    ? await tx
        .select()
        .from(encounterDiagnosis)
        .where(and(byPatient(encounterDiagnosis), isNull(encounterDiagnosis.voidedAt)))
        .orderBy(asc(encounterDiagnosis.createdAt))
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
      .select({ system: diagnosisCatalog.systemKey, code: diagnosisCatalog.code, title: diagnosisCatalog.title })
      .from(diagnosisCatalog)
      .where(inArray(diagnosisCatalog.code, codes))
    for (const row of found) titles.set(`${row.system}|${row.code}`, row.title)
  }
  const prescriptions = await tx.select().from(prescription).where(byPatient(prescription)).orderBy(asc(prescription.issuedAt))
  const items = prescriptions.length
    ? await tx.select().from(prescriptionItem).where(byPatient(prescriptionItem)).orderBy(asc(prescriptionItem.createdAt))
    : []
  const consents = await tx.select().from(consentDocument).where(byPatient(consentDocument)).orderBy(asc(consentDocument.createdAt))
  const documents = await tx
    .select()
    .from(patientDocument)
    .where(and(byPatient(patientDocument), isNull(patientDocument.retiredAt)))
    .orderBy(asc(patientDocument.createdAt))
  const appointments = await tx.select().from(appointment).where(byPatient(appointment)).orderBy(asc(appointment.startsAt))
  const hooks = await productHooks(tx, orgId)
  const productSections = await hooks.recordSections(tx, { orgId, patientId })
  const planItems = await listPlanItems(tx, orgId, patientId)
  const site = hooks.site
  const recordSite = (row: SiteColumns): RecordSite => ({ siteWords: site.words(row), bodySite: site.bodySite(row) })
  return {
    generatedAt: new Date(),
    establishment: establishmentRow ?? null,
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
    encounters: encounters.map((row) => ({
      row,
      diagnoses: diagnoses
        .filter((d) => d.encounterId === row.id)
        .map((d) => ({ ...d, ...recordSite(d), title: titles.get(`${d.diagnosisSystem}|${d.diagnosisCode}`) ?? null })),
      procedures: procedures.filter((p) => p.encounterId === row.id).map((p) => ({ ...p, ...recordSite(p) })),
      exam: {
        lines: hooks.examination.recordLines(row.examination),
        observations: hooks.examination.observations(row.examination),
      },
    })),
    productSections,
    planItems: planItems.map((item) => ({ title: item.title, status: item.status, siteWords: site.words(item, "short") })),
    prescriptions: prescriptions.map((row) => ({ row, items: items.filter((i) => i.prescriptionId === row.id) })),
    consents,
    documents,
    appointments,
  }
}

/** Nombre del archivo, sin caracteres que un sistema de archivos rechace. */
export function patientRecordFileName(record: PatientRecord, ext: string): string {
  const name = record.person.displayName.replace(/[\\/:*?"<>|]+/g, " ").trim()
  return `Historia de ${name}.${ext}`
}

function diagnosisText(d: { diagnosisSystem: string; diagnosisCode: string; title: string | null }): string {
  const short = isDiagnosisSystem(d.diagnosisSystem) ? DIAGNOSIS_SYSTEM_INFO[d.diagnosisSystem].short : d.diagnosisSystem
  return `${short} ${d.diagnosisCode}${d.title ? ` ${d.title}` : ""}`
}

function siteText(p: RecordSite): string {
  return p.siteWords ? ` · ${p.siteWords}` : ""
}

const ENCOUNTER_WORDS: Record<string, string> = { borrador: "en curso", finalizada: "cerrada", anulada: "anulada" }
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

/** El PDF para leer: todo lo de la persona, en el estilo de sus recetas y consentimientos. */
export async function renderPatientRecordPdf(record: PatientRecord): Promise<Uint8Array> {
  const zone = zoneOf(record.establishment)
  const p = record.person
  const { pdf, w } = await newWriter(`Historia de ${p.displayName}`)
  header(w, record.establishment)
  w.text("HISTORIA CLÍNICA · COPIA PARA LA PERSONA", { size: 9, bold: true, color: MUTED })
  w.text(p.displayName, { size: 15, bold: true })
  w.text(patientLine({ ...p, birthDate: p.birthDate }))
  w.text(`Generada el ${when(record.generatedAt, zone)} a pedido de la persona · incluye todo lo registrado hasta hoy`, {
    size: 8,
    color: MUTED,
  })

  w.heading("Datos personales")
  w.text(
    [
      p.sex ? `Sexo: ${SEX_LABELS[p.sex as keyof typeof SEX_LABELS] ?? p.sex}` : null,
      p.phone ? `Teléfono: ${p.phone}` : null,
      p.email ? `Correo: ${p.email}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Sin datos de contacto registrados.",
  )
  if (record.contacts.length)
    w.list(
      record.contacts.map(
        (c) =>
          `${c.displayName} · ${c.detail ?? RELATION_WORDS[c.relationship] ?? c.relationship}${c.phone ? ` · ${c.phone}` : ""}`,
      ),
    )

  w.heading("Alergias, antecedentes y medicamentos")
  if (!record.allergies.length && !record.conditions.length && !record.medications.length) w.text("Sin registros.")
  if (record.allergies.length)
    w.list(
      record.allergies.map(
        (a) => `${a.kind === "intolerancia" ? "Intolerancia" : "Alergia"}: ${a.substance}${a.severity && a.severity !== "desconocida" ? ` (${a.severity})` : ""}${a.reaction ? ` · ${a.reaction}` : ""}`,
      ),
    )
  if (record.conditions.length)
    w.list(record.conditions.map((c) => `Antecedente: ${c.name} · ${c.status}${c.diagnosisCode ? ` · ${c.diagnosisCode}` : ""}`))
  if (record.medications.length)
    w.list(record.medications.map((m) => `Medicamento: ${m.name}${m.dose ? ` · ${m.dose}` : ""}${m.frequency ? ` · ${m.frequency}` : ""}`))

  w.heading(`Atenciones (${record.encounters.length})`)
  if (!record.encounters.length) w.text("Sin atenciones registradas.")
  for (const { row, diagnoses, procedures, exam } of record.encounters) {
    w.gap(4)
    w.text(`${when(row.startedAt, zone)} · ${ENCOUNTER_WORDS[row.status] ?? row.status}`, { bold: true })
    if (row.reason) w.text(`Motivo: ${row.reason}`)
    if (row.presentIllness) w.text(`Enfermedad actual: ${row.presentIllness}`)
    const vitals = (row.vitals ?? {}) as Record<string, unknown>
    const vitalText = VITAL_SIGNS.filter((v) => typeof vitals[v.key] === "number")
      .map((v) => `${v.label} ${vitals[v.key]} ${v.suffix}`)
      .join(" · ")
    if (vitalText) w.text(`Signos vitales: ${vitalText}`)
    if (exam.lines.length) {
      w.text("Examen físico:")
      w.list(exam.lines)
    }
    if (diagnoses.length) w.list(diagnoses.map((d) => `Diagnóstico: ${diagnosisText(d)}${siteText(d)}`))
    if (procedures.length)
      w.list(procedures.map((pr) => `Procedimiento: ${pr.description}${siteText(pr)}`))
    if (row.evolution) w.text(`Evolución: ${row.evolution}`)
    if (row.indications) w.text(`Indicaciones: ${row.indications}`)
    if (row.signerName)
      w.text(
        `Firmó: ${row.signerName}${row.signerTitle ? ` · ${row.signerTitle}` : ""}${row.signerRegistration ? ` · ${row.signerRegistration}` : ""}`,
        { size: 8, color: MUTED },
      )
    if (row.status === "anulada" && row.voidReason) w.text(`Anulada: ${row.voidReason}`, { size: 8, color: MUTED })
  }

  for (const section of record.productSections) {
    w.heading(section.title)
    if (!section.lines.length) w.text(section.empty)
    else w.list(section.lines)
  }

  w.heading("Plan de tratamiento")
  if (!record.planItems.length) w.text("Sin tratamientos en el plan.")
  else
    w.list(
      record.planItems.map((i) => `${i.title}${i.siteWords ? ` · ${i.siteWords}` : ""} · ${planStatusWords(i.status)}`),
    )

  w.heading("Recetas")
  if (!record.prescriptions.length) w.text("Sin recetas.")
  for (const { row, items } of record.prescriptions) {
    w.text(
      `Receta N.º ${row.prescriptionNumber} · ${when(row.issuedAt, zone)}${row.status === "anulada" ? " · anulada" : ""}`,
      { bold: true },
    )
    w.list(
      items.map(
        (i) =>
          `${i.medicationName}${i.strength ? ` ${i.strength}` : ""}${i.dose ? ` · ${i.dose}` : ""}${i.frequency ? ` · ${i.frequency}` : ""}${i.duration ? ` · ${i.duration}` : ""}`,
      ),
    )
  }

  w.heading("Consentimientos")
  if (!record.consents.length) w.text("Sin consentimientos.")
  else
    w.list(
      record.consents.map(
        (c) =>
          `${c.titleSnapshot} · ${CONSENT_WORDS[c.status] ?? c.status}${
            c.status === "revocado" && c.revokedAt
              ? ` el ${when(c.revokedAt, zone)}`
              : c.signedAt
                ? ` el ${when(c.signedAt, zone)}`
                : ""
          }${c.pdfSha256 ? ` · huella ${c.pdfSha256.slice(0, 16)}…` : ""}`,
      ),
    )

  w.heading("Imágenes y documentos")
  if (!record.documents.length) w.text("Sin imágenes ni documentos.")
  else {
    w.text("Los archivos van aparte, en la carpeta «documentos» del ZIP.", { size: 8, color: MUTED })
    w.list(record.documents.map((d) => `${d.label} · ${when(d.capturedAt ?? d.createdAt, zone)}`))
  }

  w.heading("Citas")
  if (!record.appointments.length) w.text("Sin citas.")
  else
    w.list(
      record.appointments.map(
        (a) => `${when(a.startsAt, zone)} · ${a.serviceName ?? a.reason ?? "Cita"} · ${APPOINTMENT_WORDS[a.status] ?? a.status}`,
      ),
    )
  w.gap(14)
  w.text(
    `Copia entregada por ${record.establishment?.tradeName || record.establishment?.legalName || "la clínica"} a pedido de la persona.`,
    { size: 7, color: MUTED },
  )
  return pdf.save({ useObjectStreams: false })
}

type Resource = Record<string, unknown> & { resourceType: string; id: string }

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
      { use: "usual", type: { text: "Historia clínica" }, value: String(p.patientNumber).padStart(6, "0") },
      ...(p.docNumber
        ? [
            {
              use: "official",
              type: docCode ? { coding: [{ system: HL7_IDENTIFIER_TYPE_SYSTEM, code: docCode }], text: p.docType } : { text: p.docType },
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
      id: `${p.patientId}-${c.contactId}`,
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
        coding: [{ system: FHIR_ALLERGY_VERIFICATION_SYSTEM, code: fhirCode(ALLERGY_VERIFICATION_FHIR, a.verification) ?? "unconfirmed" }],
      },
      type: fhirCode(ALLERGY_TYPE_FHIR, a.kind) ?? "allergy",
      ...(category ? { category: [category] } : {}),
      ...(fhirCode(ALLERGY_CRITICALITY_FHIR, a.criticality) ? { criticality: fhirCode(ALLERGY_CRITICALITY_FHIR, a.criticality) } : {}),
      code: { text: a.substance },
      ...(a.reaction || severity
        ? { reaction: [{ manifestation: [{ text: a.reaction ?? "Reacción no descrita" }], ...(severity ? { severity } : {}) }] }
        : {}),
    })
  }
  for (const c of record.conditions)
    resources.push({
      resourceType: "Condition",
      id: c.id,
      subject: patientRef,
      clinicalStatus: {
        coding: [{ system: FHIR_CONDITION_CLINICAL_SYSTEM, code: fhirCode(CONDITION_CLINICAL_STATUS_FHIR, c.status) ?? "active" }],
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
      ...(m.dose || m.frequency ? { dosage: [{ text: [m.dose, m.frequency].filter(Boolean).join(" · ") }] } : {}),
    })
  for (const { row, diagnoses, procedures, exam } of record.encounters) {
    const encounterRef = { reference: `Encounter/${row.id}` }
    resources.push({
      resourceType: "Encounter",
      id: row.id,
      status: fhirCode(ENCOUNTER_STATUS_FHIR, row.status) ?? "unknown",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
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
          coding: [{ system: FHIR_CONDITION_CLINICAL_SYSTEM, code: fhirCode(CONDITION_CLINICAL_STATUS_FHIR, d.status) ?? "active" }],
        },
        ...(d.diagnosisType
          ? { verificationStatus: { coding: [{ system: FHIR_CONDITION_VERIFICATION_SYSTEM, code: d.diagnosisType }] } }
          : {}),
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
        code: diagnosisCodeable(d.diagnosisSystem, d.diagnosisCode, d.title),
        ...(d.bodySite ? { bodySite: [d.bodySite] } : {}),
      })
    for (const pr of procedures)
      resources.push({
        resourceType: "Procedure",
        id: pr.id,
        status: row.status === "anulada" ? "entered-in-error" : row.status === "finalizada" ? "completed" : "in-progress",
        subject: patientRef,
        encounter: encounterRef,
        code: { text: pr.description },
        ...(pr.bodySite ? { bodySite: [pr.bodySite] } : {}),
        performedDateTime: pr.createdAt.toISOString(),
      })
    const vitals = (row.vitals ?? {}) as Record<string, unknown>
    for (const v of VITAL_SIGNS) {
      const value = vitals[v.key]
      if (typeof value !== "number") continue
      resources.push({
        resourceType: "Observation",
        id: `${row.id}-${v.key}`,
        status: "final",
        category: [{ coding: [{ system: FHIR_OBSERVATION_CATEGORY_SYSTEM, code: "vital-signs" }] }],
        code: { coding: [{ system: FHIR_LOINC_SYSTEM, code: v.loinc, display: v.label }], text: v.label },
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
        status: "final",
        category: [{ coding: [{ system: FHIR_OBSERVATION_CATEGORY_SYSTEM, code: "exam" }] }],
        code: { text: part.text },
        subject: patientRef,
        encounter: encounterRef,
        effectiveDateTime: row.startedAt.toISOString(),
        ...(part.value === null
          ? { dataAbsentReason: { coding: [{ system: FHIR_DATA_ABSENT_REASON_SYSTEM, code: "not-performed" }] } }
          : { valueString: part.value }),
        ...(part.interpretation
          ? { interpretation: [{ coding: [{ system: FHIR_OBSERVATION_INTERPRETATION_SYSTEM, code: part.interpretation }] }] }
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
          ...(item.atcCode ? { coding: [{ system: "http://www.whocc.no/atc", code: item.atcCode }] } : {}),
          text: [item.medicationName, item.strength].filter(Boolean).join(" "),
        },
        dosageInstruction: [
          { text: [item.dose, item.route, item.frequency, item.duration, item.instructions].filter(Boolean).join(" · ") },
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
  for (const d of record.documents)
    resources.push({
      resourceType: "DocumentReference",
      id: d.id,
      status: "current",
      type: { text: d.label },
      category: [{ text: d.category }],
      subject: patientRef,
      date: d.createdAt.toISOString(),
      content: [{ attachment: { contentType: d.contentType, title: d.label, url: `documentos/${documentFileName(d)}` } }],
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

/** El nombre de un documento dentro del ZIP: su id y su extensión, para que no choquen. */
export function documentFileName(d: { id: string; label: string; storageKey: string }): string {
  // «Consentimiento firmado: Exodoncia» → «Consentimiento firmado - Exodoncia».
  const label = d.label.replace(/\s*[\\/:*?"<>|]+\s*/g, " - ").trim().slice(0, 80)
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
  return { recipient: { contactId: recipient.contactId, displayName: recipient.displayName }, channels }
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
  if (request.status !== "pendiente") throw new ServiceError("DATA_REQUEST_CLOSED", 409, "Este pedido ya se respondió")
  if (!request.verifiedAt)
    throw new ServiceError("DATA_REQUEST_NOT_VERIFIED", 409, "Primero comprueba que es ella o su representante")
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
  const pdf = await renderPatientRecordPdf(record)
  const clinic = record.establishment?.tradeName || record.establishment?.legalName || ""
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
      files.push({ name: `documentos/${folder}/DICOM/${String(slice.index + 1).padStart(5, "0")}.dcm`, storageKey: slice.storageKey })
  }
  return files
}
