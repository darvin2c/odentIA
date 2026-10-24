/**
 * Bitácora de consultas a la historia clínica: quién abrió qué parte de la
 * ficha de quién y cuándo. Complementa a `audit_event`, que solo registra
 * cambios. Una fila por usuario, paciente, recurso y hora: deja traza de la
 * consulta sin multiplicarla por cada petición de la misma lectura.
 */
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { clinicalAccessLog } from "@odentia/db/schema/clinical"
import { and, desc, eq, sql } from "drizzle-orm"
import { validation } from "./errors.js"
import { requirePatient } from "./patients.js"

/** Partes de la ficha cuya lectura se registra. */
export const CLINICAL_ACCESS_RESOURCES = [
  "resumen",
  "antecedentes",
  "odontograma",
  "periodontograma",
  "historia",
  "atenciones",
  "diagnosticos",
  "notas",
  "plan",
  "tratamientos",
  "controles",
  "recetas",
  /** Descansos médicos (issue 229). */
  "descansos",
  "documentos",
  "formularios",
  "consentimientos",
  "ordenes",
  /** Descargó la historia completa (ADR 0080). */
  "descarga",
  /** Abrió con motivo una historia bloqueada (ADR 0080). */
  "apertura",
] as const
export type ClinicalAccessResource = (typeof CLINICAL_ACCESS_RESOURCES)[number]

export async function recordClinicalAccess(
  tx: Db,
  orgId: string,
  userId: string,
  patientId: string,
  resource: ClinicalAccessResource,
): Promise<void> {
  if (!(CLINICAL_ACCESS_RESOURCES as readonly string[]).includes(resource))
    throw validation("Recurso clínico inválido")
  await tx
    .insert(clinicalAccessLog)
    .values({
      organizationId: orgId,
      patientId,
      userId,
      resource,
      bucket: sql`date_trunc('hour', now())`,
    })
    .onConflictDoUpdate({
      // La clave primaria es la franja: repetir la lectura en la misma
      // hora solo suma, sin tocar ningún índice (actualización HOT).
      target: [
        clinicalAccessLog.organizationId,
        clinicalAccessLog.patientId,
        clinicalAccessLog.bucket,
        clinicalAccessLog.userId,
        clinicalAccessLog.resource,
      ],
      set: { lastAt: sql`now()`, hits: sql`${clinicalAccessLog.hits} + 1` },
    })
}

export interface ClinicalAccessItem {
  userId: string
  userName: string | null
  resource: string
  firstAt: Date
  lastAt: Date
  hits: number
}

export async function listClinicalAccess(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { limit?: number } = {},
): Promise<ClinicalAccessItem[]> {
  await requirePatient(tx, orgId, patientId)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200)
  return tx
    .select({
      userId: clinicalAccessLog.userId,
      userName: user.name,
      resource: clinicalAccessLog.resource,
      firstAt: clinicalAccessLog.firstAt,
      lastAt: clinicalAccessLog.lastAt,
      hits: clinicalAccessLog.hits,
    })
    .from(clinicalAccessLog)
    .leftJoin(user, eq(user.id, clinicalAccessLog.userId))
    .where(
      and(
        eq(clinicalAccessLog.organizationId, orgId),
        eq(clinicalAccessLog.patientId, patientId),
      ),
    )
    // Recorre la clave primaria desde la franja más reciente; dentro de la
    // misma hora, lo último consultado primero.
    .orderBy(desc(clinicalAccessLog.bucket), desc(clinicalAccessLog.lastAt))
    .limit(limit)
}
