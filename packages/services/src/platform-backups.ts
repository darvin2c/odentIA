import type { Db } from "@odentia/db"
import { platformBackup } from "@odentia/db/schema/admin-backups"
import { desc, eq } from "drizzle-orm"
import { reportAutomaticCase } from "./model-outage.js"

/* ---------- Backups verificados («Backup sin verificar» en Soporte) ---------- */

/** El backup corre una vez al día: con dos horas de holgura antes de avisar. */
export const BACKUP_STALE_HOURS = 26

export type BackupHealth =
  | { state: "al_dia"; lastVerifiedAt: Date }
  /** La última vuelta falló: dónde y por qué. */
  | { state: "fallido"; at: Date; step: string; detail: string; lastVerifiedAt: Date | null }
  /** Pasaron más de 26 horas sin un backup verificado (o el servicio no corre). */
  | { state: "vencido"; lastVerifiedAt: Date | null }
  /** Sin vueltas registradas y sin plazo vencido: nada que juzgar todavía. */
  | { state: "sin_registro" }

/**
 * Cómo están los backups, según lo que anotó el servicio `backup`.
 * `expectedSince`: desde cuándo debería haber backups (sin ninguna vuelta
 * anotada, pasado el plazo desde ahí también es vencido); sin él, una tabla
 * vacía no se juzga (desarrollo y pruebas no tienen backups).
 */
export async function backupHealth(ownerDb: Db, options: { now?: Date; expectedSince?: Date } = {}): Promise<BackupHealth> {
  const now = options.now ?? new Date()
  const staleBefore = now.getTime() - BACKUP_STALE_HOURS * 3_600_000
  const [latest] = await ownerDb.select().from(platformBackup).orderBy(desc(platformBackup.finishedAt)).limit(1)
  const [verified] = await ownerDb
    .select({ finishedAt: platformBackup.finishedAt })
    .from(platformBackup)
    .where(eq(platformBackup.status, "verificado"))
    .orderBy(desc(platformBackup.finishedAt))
    .limit(1)
  const lastVerifiedAt = verified?.finishedAt ?? null
  if (latest?.status === "fallido")
    return { state: "fallido", at: latest.finishedAt, step: latest.step ?? "volcado", detail: latest.detail ?? "", lastVerifiedAt }
  if (lastVerifiedAt) return lastVerifiedAt.getTime() < staleBefore ? { state: "vencido", lastVerifiedAt } : { state: "al_dia", lastVerifiedAt }
  if (options.expectedSince && options.expectedSince.getTime() < staleBefore) return { state: "vencido", lastVerifiedAt: null }
  return { state: "sin_registro" }
}

const STEP_WORDS: Record<string, string> = {
  volcado: "al sacar el volcado de la base",
  restauracion: "al restaurarlo en la base de prueba",
  comprobacion: "al comprobar lo restaurado",
  subida: "al subirlo al bucket",
}

/** Lo que dice el aviso, o nada si los backups están al día. */
export function backupProblemWords(health: BackupHealth): string | null {
  const last = (at: Date | null) => (at ? `el último verificado es del ${at.toISOString()}` : "no hay ninguno verificado")
  if (health.state === "fallido")
    return `El backup falló ${STEP_WORDS[health.step] ?? health.step} (${health.at.toISOString()}); ${last(health.lastVerifiedAt)}`
  if (health.state === "vencido")
    return `Más de ${BACKUP_STALE_HOURS} horas sin un backup verificado: ${last(health.lastVerifiedAt)}. Revisa que el servicio backup esté corriendo`
  return null
}

/**
 * Avisa a Soporte de odentIA si los backups no están al día: un solo caso
 * abierto «Backup sin verificar» (con su correo al buzón de soporte) hasta que
 * alguien lo resuelve. No es de ninguna clínica.
 */
export async function reportBackupProblem(ownerDb: Db, health: BackupHealth): Promise<{ caseId: string; created: boolean } | null> {
  const words = backupProblemWords(health)
  if (!words) return null
  return reportAutomaticCase(ownerDb, {
    dedupeKey: "backup-sin-verificar",
    title: "Backup sin verificar",
    note: words,
    detail: health.state === "fallido" && health.detail ? `${words}. ${health.detail}` : words,
    screen: "/",
  })
}
