/**
 * Cargar los datos de una clínica nueva desde la administración (ADR 0104):
 * el ensayo, que no guarda nada, y la carga por tandas. Recibe el plan que
 * preparó la skill de carga (`clinic-import-plan.ts`) y crea cada persona con
 * las operaciones de siempre: `createPatient` y `createPerson`, con sus
 * validaciones y su auditoría. Nada de esto envía mensajes ni enciende
 * automatizaciones.
 *
 * Corre con la conexión owner, después de autorizar al personal con segundo
 * factor, y con el contexto de la organización abierto (`withOrgContext`).
 * Lo que ya entró queda en `clinic_import_row`: repetir una tanda o el plan
 * entero no crea otra ficha.
 */
import { clinicalProfileFor, documentIssuerCountry, normalizePhone } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { clinicImportRow } from "@odentia/db/schema/admin-imports"
import { patient } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, eq, inArray, sql } from "drizzle-orm"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import {
  checkClinicImportPlan,
  type ClinicImportCheck,
  type ClinicImportPerson,
  type ClinicImportPlan,
  clinicImportPlanSha256,
  foldName,
} from "./clinic-import-plan.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { createPatient, patientOrganizationToday } from "./patients.js"
import { createPerson } from "./people.js"

/** Personas por tanda: cada una es una transacción corta. */
export const CLINIC_IMPORT_BATCH = 200

/**
 * Qué pasará con una fila: `nueva` (se crea), `cargada` (ya entró antes),
 * `existe` (ya está en la clínica con ese documento: no se toca) o `error`
 * (no se carga).
 */
export type ClinicImportRowStatus = "nueva" | "cargada" | "existe" | "error"

export interface ClinicImportPreviewRow {
  key: string
  name: string
  patient: boolean
  origin: { file: string; row: number } | null
  status: ClinicImportRowStatus
  messages: Array<{ level: "error" | "aviso"; message: string }>
}

export interface ClinicImportPreview {
  planSha256: string
  /** Las claves en el orden en que se cargan; la carga va por tandas sobre esta lista. */
  order: string[]
  totals: {
    nuevas: number
    pacientes: number
    responsables: number
    cargadas: number
    existen: number
    errores: number
    paraRevisar: number
    fuera: number
  }
  /** Solo las filas que dicen algo (error, aviso, ya cargada o ya existente), en el orden de carga. */
  rows: ClinicImportPreviewRow[]
  omitted: ClinicImportPlan["omitted"]
}

interface Snapshot {
  sha: string
  check: ClinicImportCheck
  byKey: Map<string, ClinicImportPerson>
  /** Lo que ya entró: clave → persona. */
  loaded: Map<string, string>
  /** Quien ya está en la clínica con el documento de la fila: clave → nombre y si es paciente. */
  existing: Map<string, { contactId: string; name: string; isPatient: boolean }>
  /** Avisos que dependen de la clínica (teléfono o nombre de alguien que ya está). */
  clinicNotes: Map<string, string[]>
}

/** El ensayo y la carga muestran y escriben datos de pacientes: solo la administración. */
function requireImportAdmin(actor: AdminActor | null): AdminActor {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo un administrador carga datos de una clínica")
  return actor
}

async function snapshot(tx: Db, orgId: string, plan: ClinicImportPlan): Promise<Snapshot> {
  const country = await findOrgCountry(tx, orgId)
  if (!country) throw notFound("Clínica")
  if (country !== plan.countryCode)
    throw validation(`El plan es para ${plan.countryCode} y la clínica es de ${country}: prepáralo con el país de la clínica`)
  const check = checkClinicImportPlan(plan, await patientOrganizationToday(tx, orgId))
  const byKey = new Map(plan.people.map((person) => [person.key, person]))

  const loadedRows = await tx
    .select({ key: clinicImportRow.sourceKey, contactId: clinicImportRow.contactId })
    .from(clinicImportRow)
    .where(eq(clinicImportRow.organizationId, orgId))
  const loaded = new Map(loadedRows.filter((row) => byKey.has(row.key)).map((row) => [row.key, row.contactId]))

  // El documento identifica a la persona (ADR 0001): la que ya está no se vuelve a crear.
  const profile = clinicalProfileFor(plan.countryCode)
  const docOf = (docType: string | null | undefined, docNumber: string | null | undefined, docCountry: string | null | undefined) =>
    docType && docNumber ? `${documentIssuerCountry(profile, docType, docCountry) ?? ""}|${docType}|${docNumber.trim().toUpperCase()}` : null
  const numbers = [...new Set(plan.people.map((person) => person.demographics.docNumber?.trim()).filter((value): value is string => !!value))]
  const existing = new Map<string, { contactId: string; name: string; isPatient: boolean }>()
  if (numbers.length) {
    const owners = await tx
      .select({
        id: contact.id,
        name: contact.displayName,
        docType: contact.docType,
        docNumber: contact.docNumber,
        docCountry: contact.docCountry,
        patientId: patient.id,
      })
      .from(contact)
      .leftJoin(patient, and(eq(patient.organizationId, contact.organizationId), eq(patient.personId, contact.id)))
      .where(and(eq(contact.organizationId, orgId), inArray(contact.docNumber, numbers)))
    const byDoc = new Map(owners.map((owner) => [docOf(owner.docType, owner.docNumber, owner.docCountry), owner]))
    for (const person of plan.people) {
      const { docType, docNumber, docCountry } = person.demographics
      const owner = byDoc.get(docOf(docType, docNumber, docCountry))
      if (owner && !loaded.has(person.key)) existing.set(person.key, { contactId: owner.id, name: owner.name, isPatient: !!owner.patientId })
    }
  }

  // Parecidos con quien ya está en la clínica: se avisan y nunca se unen solos.
  const clinicNotes = new Map<string, string[]>()
  const note = (key: string, message: string) => clinicNotes.set(key, [...(clinicNotes.get(key) ?? []), message])
  const pending = plan.people.filter((person) => !loaded.has(person.key) && !existing.has(person.key))
  const phones = new Map<string, string[]>()
  for (const person of pending) {
    const phone = normalizePhone(person.demographics.phone, plan.countryCode)
    if (phone) phones.set(phone, [...(phones.get(phone) ?? []), person.key])
  }
  const names = new Map<string, string[]>()
  for (const person of pending) {
    const name = foldName(person.demographics.displayName)
    names.set(name, [...(names.get(name) ?? []), person.key])
  }
  const loadedIds = [...loaded.values()]
  if (phones.size) {
    const rows = await tx
      .select({ id: contact.id, name: contact.displayName, phone: contact.phone })
      .from(contact)
      .where(and(eq(contact.organizationId, orgId), inArray(contact.phone, [...phones.keys()])))
    for (const row of rows) {
      if (loadedIds.includes(row.id)) continue
      for (const key of phones.get(row.phone ?? "") ?? []) note(key, `Su teléfono es de ${row.name}, que ya está en la clínica: quedan como personas distintas`)
    }
  }
  if (names.size) {
    // Sin tildes, como el buscador (ADR 0066).
    const folded = sql<string>`search_fold(${contact.displayName})`
    const rows = await tx
      .select({ id: contact.id, name: contact.displayName, folded })
      .from(contact)
      .where(and(eq(contact.organizationId, orgId), inArray(folded, [...names.keys()])))
    for (const row of rows) {
      if (loadedIds.includes(row.id)) continue
      for (const key of names.get(foldName(row.folded)) ?? []) note(key, `Se llama igual que ${row.name}, que ya está en la clínica: revisa si es la misma persona`)
    }
  }

  return { sha: clinicImportPlanSha256(plan), check, byKey, loaded, existing, clinicNotes }
}

function statusOf(snap: Snapshot, key: string): ClinicImportRowStatus {
  if (snap.loaded.has(key)) return "cargada"
  if (snap.check.blocked.includes(key)) return "error"
  if (snap.existing.has(key)) return "existe"
  return "nueva"
}

/**
 * El ensayo: lo que pasaría con cada fila si se carga ahora. No escribe nada.
 */
export async function previewClinicImport(
  tx: Db,
  orgId: string,
  actor: AdminActor | null,
  plan: ClinicImportPlan,
): Promise<ClinicImportPreview> {
  requireImportAdmin(actor)
  const snap = await snapshot(tx, orgId, plan)
  const issuesByKey = new Map<string, ClinicImportPreviewRow["messages"]>()
  for (const issue of snap.check.issues) issuesByKey.set(issue.key, [...(issuesByKey.get(issue.key) ?? []), { level: issue.level, message: issue.message }])
  const rows: ClinicImportPreviewRow[] = []
  const totals = { nuevas: 0, pacientes: 0, responsables: 0, cargadas: 0, existen: 0, errores: 0, paraRevisar: 0, fuera: plan.omitted.length }
  for (const key of snap.check.order) {
    const person = snap.byKey.get(key)!
    const status = statusOf(snap, key)
    // Lo que ya entró o ya estaba no se toca: sus avisos de datos no aplican.
    const messages = status === "cargada" || status === "existe" ? [] : [...(issuesByKey.get(key) ?? [])]
    for (const message of snap.clinicNotes.get(key) ?? []) messages.push({ level: "aviso", message })
    const owner = snap.existing.get(key)
    if (status === "existe" && owner)
      messages.unshift({
        level: "aviso",
        message: owner.isPatient || !person.patient
          ? `Ya está en la clínica como ${owner.name}: no se toca`
          : `Ya está en la clínica como ${owner.name}, sin ficha: regístrala desde su página`,
      })
    if (status === "nueva") {
      totals.nuevas++
      if (person.patient) totals.pacientes++
      else totals.responsables++
    }
    if (status === "cargada") totals.cargadas++
    if (status === "existe") totals.existen++
    if (status === "error") totals.errores++
    if (status !== "error" && messages.some((message) => message.level === "aviso")) totals.paraRevisar++
    if (status !== "nueva" || messages.length)
      rows.push({ key, name: person.demographics.displayName, patient: person.patient, origin: person.origin ?? null, status, messages })
  }
  return { planSha256: snap.sha, order: snap.check.order, totals, rows, omitted: plan.omitted }
}

export interface ClinicImportBatchResult {
  planSha256: string
  /** Desde dónde sigue la próxima tanda; igual a `total` cuando terminó. */
  next: number
  total: number
  done: { creadas: number; existentes: number; yaCargadas: number; errores: number }
  /** Lo que no entró en esta tanda y por qué. */
  failed: Array<{ key: string; name: string; message: string }>
}

/**
 * Carga una tanda del plan: las personas `order[from, from + CLINIC_IMPORT_BATCH)`.
 * Cada persona va en su propio punto de guardado: si una falla (su documento
 * ya es de otra ficha), las demás siguen y la fallida se dice.
 */
export async function applyClinicImportBatch(
  tx: Db,
  orgId: string,
  actor: AdminActor | null,
  plan: ClinicImportPlan,
  from: number,
): Promise<ClinicImportBatchResult> {
  const staff = requireImportAdmin(actor)
  const snap = await snapshot(tx, orgId, plan)
  const total = snap.check.order.length
  if (!Number.isInteger(from) || from < 0 || from > total) throw validation("La tanda no está en el plan")
  const keys = snap.check.order.slice(from, from + CLINIC_IMPORT_BATCH)
  const done = { creadas: 0, existentes: 0, yaCargadas: 0, errores: 0 }
  const failed: ClinicImportBatchResult["failed"] = []
  const issues = new Map<string, string>()
  for (const issue of snap.check.issues) if (issue.level === "error" && !issues.has(issue.key)) issues.set(issue.key, issue.message)

  for (const key of keys) {
    const person = snap.byKey.get(key)!
    const fail = (message: string) => {
      done.errores++
      failed.push({ key, name: person.demographics.displayName, message })
    }
    const status = statusOf(snap, key)
    if (status === "cargada") {
      done.yaCargadas++
      continue
    }
    if (status === "error") {
      fail(issues.get(key) ?? "Tiene errores en el plan")
      continue
    }
    const row = {
      organizationId: orgId,
      sourceKey: key,
      planSha256: snap.sha,
      originFile: person.origin?.file ?? null,
      originRow: person.origin?.row ?? null,
      createdBy: staff.userId,
    }
    const owner = snap.existing.get(key)
    if (owner) {
      await tx.insert(clinicImportRow).values({ ...row, contactId: owner.contactId, outcome: "existente" })
      snap.loaded.set(key, owner.contactId)
      done.existentes++
      continue
    }
    const guardianKey = person.guardian?.key
    const guardianId = guardianKey ? snap.loaded.get(guardianKey) : undefined
    if (guardianKey && !guardianId) {
      fail("Quien habla por ella todavía no está cargada")
      continue
    }
    try {
      const contactId = await tx.transaction(async (sp) => {
        const { demographics } = person
        let id: string
        if (person.patient) {
          const ownContact = !!(demographics.phone || demographics.email)
          const created = await createPatient(sp, orgId, staff.userId, {
            ...demographics,
            contacts: guardianId
              ? [{ contactId: guardianId, relationship: person.guardian!.relationship, kinship: person.guardian!.kinship ?? null, isPreferred: !ownContact }]
              : [],
          })
          id = created.personId
        } else {
          id = (
            await createPerson(sp, orgId, { userId: staff.userId }, {
              givenNames: demographics.givenNames,
              familyName: demographics.familyName,
              displayName: demographics.displayName,
              phone: demographics.phone,
              email: demographics.email,
              docType: demographics.docType,
              docNumber: demographics.docNumber,
              docCountry: demographics.docCountry,
              birthDate: demographics.birthDate,
              sex: demographics.sex,
            })
          ).id
        }
        await sp.insert(clinicImportRow).values({ ...row, contactId: id, outcome: "creada" })
        return id
      })
      snap.loaded.set(key, contactId)
      done.creadas++
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error
      fail(error.message)
    }
  }

  const next = from + keys.length
  await writeAdminAudit(tx, staff, {
    action: "org.data_import",
    organizationId: orgId,
    metadata: { planSha256: snap.sha, from, to: next, total, ...done },
  })
  return { planSha256: snap.sha, next, total, done, failed }
}
