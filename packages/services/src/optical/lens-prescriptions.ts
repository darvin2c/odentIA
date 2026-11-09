import type { Db } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import { lensPrescription } from "@odentia/db/schema/optical"
import { auditEvent } from "@odentia/db/schema/org"
import {
  defaultValidUntil,
  EYES,
  type EyeExam,
  formatDay,
  lensText,
  lensesFromExam,
  type PrescriptionKind,
  type PrescriptionLenses,
  PRESCRIPTION_KINDS,
  parsePrescriptionLenses,
  prescriptionNotices,
  readEyeExam,
} from "@odentia/optical"
import { and, desc, eq, isNull } from "drizzle-orm"
import { assertAttending } from "../encounter-attending.js"
import { invalidField, notFound, ServiceError } from "../errors.js"
import { clinicToday } from "../inventory-stock.js"
import { orgProduct } from "../locale.js"
import { requirePatient } from "../patients.js"
import { requireProfessionalSignature } from "../professional-profiles.js"

/**
 * Las recetas de lentes de vistIA (entrega 3 del plan): emitir la de la óptica
 * desde el examen de la atención, transcribir la externa, verificarla, anularla
 * y leer la vigente. Una receta emitida no cambia (la guarda la base).
 */

const NOTES_MAX = 2000

/** La receta de lentes es de vistIA: en una clínica de otro producto no existe. */
async function requireOptical(tx: Db, orgId: string): Promise<void> {
  if ((await orgProduct(tx, orgId)) !== "optical") throw notFound("Receta de lentes")
}
const NAME_MAX = 200

export interface LensPrescriptionView {
  id: string
  kind: PrescriptionKind
  source: "examen" | "externa"
  encounterId: string | null
  lenses: PrescriptionLenses
  pupillaryDistance: { od?: number; oi?: number } | null
  notes: string | null
  issuedOn: string
  validUntil: string
  prescriberName: string
  prescriberRegistration: string | null
  photoDocumentId: string | null
  verifiedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  /** Vencida o sin verificar: se informa, no impide vender. */
  notices: string[]
}

function toView(row: typeof lensPrescription.$inferSelect, today: string): LensPrescriptionView {
  const verifiedAt = row.verifiedAt ? row.verifiedAt.toISOString() : null
  return {
    id: row.id,
    kind: row.kind as PrescriptionKind,
    source: row.source as "examen" | "externa",
    encounterId: row.encounterId,
    lenses: row.lenses as PrescriptionLenses,
    pupillaryDistance: (row.pupillaryDistance as { od?: number; oi?: number } | null) ?? null,
    notes: row.notes,
    issuedOn: row.issuedOn,
    validUntil: row.validUntil,
    prescriberName: row.prescriberName,
    prescriberRegistration: row.prescriberRegistration,
    photoDocumentId: row.photoDocumentId,
    verifiedAt,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidReason: row.voidReason,
    notices: row.voidedAt ? [] : prescriptionNotices({ source: row.source as "examen" | "externa", verifiedAt, validUntil: row.validUntil }, today),
  }
}

function kindOf(value: unknown): PrescriptionKind {
  if (!PRESCRIPTION_KINDS.some((kind) => kind.key === value)) throw invalidField("kind", "Elige anteojos o lentes de contacto")
  return value as PrescriptionKind
}

function validUntilOf(value: unknown, issuedOn: string): string {
  if (value === undefined || value === null || value === "") return defaultValidUntil(issuedOn)
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw invalidField("validUntil", "Elige la fecha en el calendario")
  if (value < issuedOn) throw invalidField("validUntil", "La vigencia no puede ser anterior a la fecha de la receta")
  return value
}

function optionalText(value: unknown, field: string, label: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw invalidField(field, `${label}: escribe un texto`)
  const text = value.trim()
  if (text.length > max) throw invalidField(field, `${label}: como mucho ${max} caracteres`)
  return text || null
}

/**
 * Emite la receta de la óptica desde el examen de la atención en borrador: los
 * lentes son su refracción (de anteojos) o lo que se escribe para los de contacto;
 * la firma quien lleva la atención, con su colegiatura.
 */
export async function issueLensPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { encounterId: string; kind: unknown; lenses?: unknown; notes?: unknown; validUntil?: unknown },
): Promise<LensPrescriptionView> {
  await requireOptical(tx, orgId)
  await requirePatient(tx, orgId, patientId)
  const kind = kindOf(input.kind)
  const [enc] = await tx
    .select()
    .from(encounter)
    .where(and(eq(encounter.id, input.encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)))
    .for("update")
  if (!enc) throw notFound("Atención")
  if (enc.status === "anulada") throw new ServiceError("VOIDED", 409, "La atención está anulada")
  if (enc.status !== "borrador") throw new ServiceError("FINALIZED", 409, "La atención está finalizada")
  assertAttending(enc, actorUserId)
  const exam: EyeExam | null = readEyeExam(enc.examination)
  // De anteojos, sin lentes escritos: la refracción del examen tal cual.
  const raw = input.lenses ?? (kind === "anteojos" ? lensesFromExam(exam?.refraccion) : null)
  if (!raw) throw invalidField("lentes", "Anota la refracción en el examen de la vista o escribe la graduación")
  const parsed = parsePrescriptionLenses(kind, raw)
  if (!parsed.ok) throw invalidField(parsed.path, parsed.error)
  const signer = await requireProfessionalSignature(tx, orgId, actorUserId)
  const issuedOn = await clinicToday(tx, orgId)
  const [row] = await tx
    .insert(lensPrescription)
    .values({
      organizationId: orgId,
      patientId,
      encounterId: enc.id,
      kind,
      source: "examen",
      lenses: parsed.value,
      pupillaryDistance: exam?.dp ?? null,
      notes: optionalText(input.notes, "notes", "Las indicaciones", NOTES_MAX),
      issuedOn,
      validUntil: validUntilOf(input.validUntil, issuedOn),
      prescriberUserId: actorUserId,
      prescriberName: signer.name,
      prescriberRegistration: signer.registration,
      // La de la óptica nace verificada: la firma quien examinó.
      verifiedAt: new Date(),
      verifiedBy: actorUserId,
      createdBy: actorUserId,
    })
    .onConflictDoNothing()
    .returning()
  if (!row) throw new ServiceError("PRESCRIPTION_EXISTS", 409, "Esta atención ya tiene su receta de ese tipo: anúlala para emitir otra")
  await audit(tx, orgId, actorUserId, "lens_prescription.issued", row.id, { patientId, kind })
  return toView(row, issuedOn)
}

/**
 * Transcribe la receta que trae el cliente: queda «sin verificar» hasta que la
 * revise un optómetra. La puede transcribir quien escribe en la ficha clínica.
 */
export async function transcribeLensPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: {
    kind: unknown
    lenses: unknown
    issuedOn: unknown
    validUntil?: unknown
    prescriberName: unknown
    prescriberRegistration?: unknown
    notes?: unknown
    photoDocumentId?: string | null
  },
): Promise<LensPrescriptionView> {
  await requireOptical(tx, orgId)
  await requirePatient(tx, orgId, patientId)
  const kind = kindOf(input.kind)
  const parsed = parsePrescriptionLenses(kind, input.lenses)
  if (!parsed.ok) throw invalidField(parsed.path, parsed.error)
  const today = await clinicToday(tx, orgId)
  const issuedOn = input.issuedOn
  if (typeof issuedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || Number.isNaN(Date.parse(issuedOn)))
    throw invalidField("issuedOn", "Elige la fecha de la receta en el calendario")
  if (issuedOn > today) throw invalidField("issuedOn", "La fecha de la receta no puede ser posterior a hoy")
  const prescriberName = optionalText(input.prescriberName, "prescriberName", "Quién la firmó", NAME_MAX)
  if (!prescriberName) throw invalidField("prescriberName", "Escribe quién la firmó")
  const [row] = await tx
    .insert(lensPrescription)
    .values({
      organizationId: orgId,
      patientId,
      encounterId: null,
      kind,
      source: "externa",
      lenses: parsed.value,
      notes: optionalText(input.notes, "notes", "Las indicaciones", NOTES_MAX),
      issuedOn,
      validUntil: validUntilOf(input.validUntil, issuedOn),
      prescriberName,
      prescriberRegistration: optionalText(input.prescriberRegistration, "prescriberRegistration", "Su colegiatura", 60),
      photoDocumentId: input.photoDocumentId ?? null,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se guardó la receta")
  await audit(tx, orgId, actorUserId, "lens_prescription.transcribed", row.id, { patientId, kind })
  return toView(row, today)
}

/** Un optómetra revisó la receta externa contra su foto: deja de estar «sin verificar». */
export async function verifyLensPrescription(tx: Db, orgId: string, actorUserId: string, patientId: string, id: string) {
  await requireOptical(tx, orgId)
  const row = await locked(tx, orgId, patientId, id)
  if (row.voidedAt) throw new ServiceError("PRESCRIPTION_VOIDED", 409, "La receta está anulada")
  if (row.verifiedAt) return toView(row, await clinicToday(tx, orgId))
  await requireProfessionalSignature(tx, orgId, actorUserId)
  const [updated] = await tx
    .update(lensPrescription)
    .set({ verifiedAt: new Date(), verifiedBy: actorUserId, updatedAt: new Date() })
    .where(eq(lensPrescription.id, row.id))
    .returning()
  await audit(tx, orgId, actorUserId, "lens_prescription.verified", id, { patientId })
  return toView(updated!, await clinicToday(tx, orgId))
}

export async function voidLensPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: unknown },
) {
  const reason = optionalText(input.reason, "reason", "El motivo", NOTES_MAX)
  if (!reason) throw invalidField("reason", "Escribe el motivo")
  await requireOptical(tx, orgId)
  const row = await locked(tx, orgId, patientId, id)
  if (row.voidedAt) throw new ServiceError("PRESCRIPTION_VOIDED", 409, "La receta ya está anulada")
  const [updated] = await tx
    .update(lensPrescription)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason, updatedAt: new Date() })
    .where(eq(lensPrescription.id, row.id))
    .returning()
  await audit(tx, orgId, actorUserId, "lens_prescription.voided", id, { patientId, reason })
  return toView(updated!, await clinicToday(tx, orgId))
}

/** Las recetas de la persona, la más reciente primero. */
export async function listLensPrescriptions(tx: Db, orgId: string, patientId: string): Promise<LensPrescriptionView[]> {
  await requireOptical(tx, orgId)
  await requirePatient(tx, orgId, patientId)
  const today = await clinicToday(tx, orgId)
  const rows = await tx
    .select()
    .from(lensPrescription)
    .where(and(eq(lensPrescription.organizationId, orgId), eq(lensPrescription.patientId, patientId)))
    .orderBy(desc(lensPrescription.issuedOn), desc(lensPrescription.createdAt))
  return rows.map((row) => toView(row, today))
}

/** Las recetas en la copia de la historia: una línea por ojo de cada una, las anuladas con su motivo. */
export async function prescriptionRecordLines(tx: Db, orgId: string, patientId: string): Promise<string[]> {
  const rows = await tx
    .select()
    .from(lensPrescription)
    .where(and(eq(lensPrescription.organizationId, orgId), eq(lensPrescription.patientId, patientId)))
    .orderBy(desc(lensPrescription.issuedOn), desc(lensPrescription.createdAt))
  return rows.flatMap((row) => {
    const kind = PRESCRIPTION_KINDS.find((item) => item.key === row.kind)?.label ?? row.kind
    const lenses = row.lenses as PrescriptionLenses
    const head = `${formatDay(row.issuedOn)} · ${kind} · ${row.source === "externa" ? `externa, de ${row.prescriberName}${row.verifiedAt ? "" : ", sin verificar"}` : row.prescriberName}${row.voidedAt ? ` · anulada: ${row.voidReason}` : ""}`
    return [head, ...EYES.filter((eye) => lenses[eye.key]).map((eye) => `  ${eye.short} ${lensText(lenses[eye.key])}`)]
  })
}

/** La receta vigente de cada tipo: la más reciente sin anular (vencida, con su aviso). */
export async function currentLensPrescriptions(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<Partial<Record<PrescriptionKind, LensPrescriptionView>>> {
  const today = await clinicToday(tx, orgId)
  const rows = await tx
    .select()
    .from(lensPrescription)
    .where(and(eq(lensPrescription.organizationId, orgId), eq(lensPrescription.patientId, patientId), isNull(lensPrescription.voidedAt)))
    .orderBy(desc(lensPrescription.issuedOn), desc(lensPrescription.createdAt))
  const out: Partial<Record<PrescriptionKind, LensPrescriptionView>> = {}
  for (const row of rows) out[row.kind as PrescriptionKind] ??= toView(row, today)
  return out
}

async function locked(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx
    .select()
    .from(lensPrescription)
    .where(and(eq(lensPrescription.organizationId, orgId), eq(lensPrescription.patientId, patientId), eq(lensPrescription.id, id)))
    .for("update")
  if (!row) throw notFound("Receta")
  return row
}

async function audit(tx: Db, orgId: string, actorUserId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "lens_prescription", entityId, metadata })
}
