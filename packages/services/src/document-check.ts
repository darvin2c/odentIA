/**
 * Comprobar un documento con su QR, sin cuenta (ADR 0115): quien lo tiene en la mano
 * ve si sigue vigente. El token es firmado y no se guarda: lleva la clínica, el tipo
 * y el id, y se recalcula con la clave del servidor.
 *
 * Lo público dice solo el estado, la etiqueta, las fechas, quién firmó, las iniciales
 * del paciente y cómo llamar a la clínica. Nunca diagnóstico, medicamentos, el título
 * de un consentimiento o de una orden, el motivo de anulación ni el nombre completo.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { Db } from "@odentia/db"
import { prescription } from "@odentia/db/schema/clinical"
import { clinicalOrder, consentDocument, medicalLeave } from "@odentia/db/schema/clinical-forms"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { requirePatient } from "./patients.js"
import { productHooks } from "./products.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { clinicOriginOf } from "./public-links.js"

export const CHECKABLE_DOCUMENTS = [
  "prescription",
  "order",
  "medical_leave",
  "consent",
  "signed_odontogram",
] as const
export type CheckableDocument = (typeof CHECKABLE_DOCUMENTS)[number]

export type DocumentCheckState = "vigente" | "anulado" | "revocado" | "vencido"

/** La respuesta pública; ningún otro dato sale de aquí. */
export interface DocumentCheck {
  state: DocumentCheckState
  /** «Receta N.º 12», «Consentimiento informado». */
  label: string
  issuedAt: string | null
  /** AAAA-MM-DD; solo lo que tiene vigencia: la receta. */
  validUntil: string | null
  /** Cuándo se anuló o se revocó. */
  voidedAt: string | null
  signer: { name: string; title: string | null; registration: string | null } | null
  /** «R. Q.». */
  patientInitials: string
  clinic: { name: string; phone: string | null }
}

/** Lo que dice cada documento, antes de agregarle clínica y paciente. */
export interface DocumentCheckFacts {
  patientId: string
  state: DocumentCheckState
  label: string
  issuedAt: Date | string | null
  validUntil: string | null
  voidedAt: Date | string | null
  signer: DocumentCheck["signer"]
}

let checkKey: Buffer | null = null

/** La API y el worker la fijan al arrancar, como `configurePublicLinks`. */
export function configureDocumentChecks(secretsKey: Buffer | null): void {
  checkKey = secretsKey
}

/** La clave que firma lo que se imprime, también para el QR de «Su enlace». */
export function documentSecretsKey(): Buffer | null {
  return checkKey
}

function signature(secretsKey: Buffer, payload: string): string {
  // 128 bits bastan y dejan el QR legible: la dirección entera va en el código.
  return createHmac("sha256", secretsKey)
    .update(`comprobar-documento:${payload}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url")
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Corto a propósito: tipo y uuid en binario, seguidos de la clínica. */
export function documentCheckToken(
  secretsKey: Buffer,
  orgId: string,
  type: CheckableDocument,
  id: string,
): string {
  const payload = Buffer.concat([
    Buffer.from([CHECKABLE_DOCUMENTS.indexOf(type)]),
    Buffer.from(id.replaceAll("-", ""), "hex"),
    Buffer.from(orgId, "utf8"),
  ]).toString("base64url")
  return `${payload}.${signature(secretsKey, payload)}`
}

/** Lo que lleva el token; null si no es válido, sin distinguir por qué. */
export function readDocumentCheckToken(
  secretsKey: Buffer,
  token: string,
): { orgId: string; type: CheckableDocument; id: string } | null {
  const [payload, sig, extra] = token.split(".")
  if (!payload || !sig || extra !== undefined || payload.length > 300) return null
  const given = Buffer.from(sig)
  const expected = Buffer.from(signature(secretsKey, payload))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const raw = Buffer.from(payload, "base64url")
  if (raw.length < 18) return null
  const type = CHECKABLE_DOCUMENTS[raw[0]!]
  if (!type) return null
  const hex = raw.subarray(1, 17).toString("hex")
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  if (!UUID.test(id)) return null
  const orgId = raw.subarray(17).toString("utf8")
  return orgId ? { orgId, type, id } : null
}

/**
 * La dirección que lleva el QR, en la página pública de la clínica (la misma de «Su
 * enlace», con el dominio de su producto). Nula sin dirección pública ni clave:
 * entonces el papel sale sin QR y no promete nada.
 */
export async function documentCheckUrl(
  tx: Db,
  orgId: string,
  type: CheckableDocument,
  id: string,
): Promise<string | null> {
  if (!checkKey) return null
  const origin = await clinicOriginOf(tx, orgId)
  return origin ? `${origin}/comprobar/${documentCheckToken(checkKey, orgId, type, id)}` : null
}

/** «Rosa Quispe» → «R. Q.». */
export function patientInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0])
    .filter((letter): letter is string => !!letter)
    .slice(0, 4)
    .map((letter) => `${letter.toLocaleUpperCase("es")}.`)
    .join(" ")
}

function iso(value: Date | string | null): string | null {
  if (!value) return null
  return typeof value === "string" ? value : value.toISOString()
}

const ORDER_WORDS: Record<string, string> = {
  imagen: "Orden de imagen",
  laboratorio: "Orden de laboratorio",
  interconsulta: "Derivación",
}

async function factsOf(
  tx: Db,
  orgId: string,
  type: CheckableDocument,
  id: string,
  today: string,
): Promise<DocumentCheckFacts | null> {
  if (type === "prescription") {
    const [row] = await tx
      .select()
      .from(prescription)
      .where(and(eq(prescription.id, id), eq(prescription.organizationId, orgId)))
      .limit(1)
    if (!row) return null
    const voided = row.status === "anulada"
    return {
      patientId: row.patientId,
      state: voided ? "anulado" : row.validUntil && row.validUntil < today ? "vencido" : "vigente",
      label: `Receta N.º ${row.prescriptionNumber}`,
      issuedAt: row.issuedAt,
      validUntil: row.validUntil,
      voidedAt: voided ? row.cancelledAt : null,
      signer: row.prescriberName
        ? {
            name: row.prescriberName,
            title: row.prescriberTitle,
            registration: row.prescriberRegistration,
          }
        : null,
    }
  }
  if (type === "medical_leave") {
    const [row] = await tx
      .select()
      .from(medicalLeave)
      .where(and(eq(medicalLeave.id, id), eq(medicalLeave.organizationId, orgId)))
      .limit(1)
    if (!row) return null
    const voided = row.status === "anulado"
    return {
      patientId: row.patientId,
      // Un descanso ya cumplido sigue siendo verdadero: no vence.
      state: voided ? "anulado" : "vigente",
      label: `Descanso médico N.º ${row.leaveNumber}`,
      issuedAt: row.issuedAt,
      validUntil: null,
      voidedAt: voided ? row.cancelledAt : null,
      signer: row.signerName
        ? { name: row.signerName, title: row.signerTitle, registration: row.signerRegistration }
        : null,
    }
  }
  if (type === "order") {
    const [row] = await tx
      .select()
      .from(clinicalOrder)
      .where(and(eq(clinicalOrder.id, id), eq(clinicalOrder.organizationId, orgId)))
      .limit(1)
    if (!row) return null
    const voided = row.status === "cancelado"
    let signer: DocumentCheck["signer"] = null
    if (row.fromUserId) {
      const found = await requireProfessionalSignature(tx, orgId, row.fromUserId).catch(() => null)
      if (found) signer = { name: found.name, title: found.title, registration: found.registration }
    }
    return {
      patientId: row.patientId,
      state: voided ? "anulado" : "vigente",
      label: ORDER_WORDS[row.kind] ?? "Orden",
      issuedAt: row.createdAt,
      validUntil: null,
      voidedAt: voided ? row.cancelledAt : null,
      signer,
    }
  }
  if (type === "consent") {
    const [row] = await tx
      .select()
      .from(consentDocument)
      .where(and(eq(consentDocument.id, id), eq(consentDocument.organizationId, orgId)))
      .limit(1)
    // Un consentimiento sin firmar no es un documento que comprobar.
    if (!row || row.status === "pendiente") return null
    const state: DocumentCheckState =
      row.status === "revocado" ? "revocado" : row.status === "anulado" ? "anulado" : "vigente"
    return {
      patientId: row.patientId,
      state,
      label: "Consentimiento informado",
      issuedAt: row.signedAt,
      validUntil: null,
      voidedAt: state === "revocado" ? row.revokedAt : state === "anulado" ? row.updatedAt : null,
      signer: row.informerName
        ? {
            name: row.informerName,
            title: row.informerTitle,
            registration: row.informerRegistration,
          }
        : null,
    }
  }
  // Lo que solo existe en un producto lo responde ese producto.
  const hooks = await productHooks(tx, orgId)
  return hooks.documentCheck ? hooks.documentCheck(tx, orgId, type, id) : null
}

/** Lo que responde la ruta pública; null si el documento ya no está. */
export async function readDocumentCheck(
  tx: Db,
  orgId: string,
  type: CheckableDocument,
  id: string,
): Promise<DocumentCheck | null> {
  const [profile] = await tx
    .select({
      tradeName: orgProfile.tradeName,
      legalName: orgProfile.legalName,
      timezone: orgProfile.timezone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!profile) return null
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: profile.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  const facts = await factsOf(tx, orgId, type, id, today)
  if (!facts) return null
  const person = await requirePatient(tx, orgId, facts.patientId)
  const branches = await tx
    .select({ phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .limit(2)
  return {
    state: facts.state,
    label: facts.label,
    issuedAt: iso(facts.issuedAt),
    validUntil: facts.validUntil,
    voidedAt: iso(facts.voidedAt),
    signer: facts.signer,
    patientInitials: patientInitials(person.displayName),
    clinic: {
      name: profile.tradeName || profile.legalName || "",
      phone: branches.length === 1 ? (branches[0]?.phone ?? null) : null,
    },
  }
}
