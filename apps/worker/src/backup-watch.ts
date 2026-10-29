import type { Db } from "@odentia/db"
import { backupHealth, backupProblemWords, reportBackupProblem } from "@odentia/services"

/**
 * Revisa lo que anotó el servicio `backup` y, si el último falló o pasaron más
 * de 26 horas sin uno verificado, abre (o mantiene) el caso «Backup sin
 * verificar» en Soporte. `expectedSince`: desde cuándo corre el worker; sin
 * ninguna vuelta anotada, el plazo cuenta desde ahí.
 */
export async function runBackupWatchTick(
  ownerDb: Db,
  options: { now?: Date; expectedSince: Date },
): Promise<{ problem: string | null; caseCreated: boolean }> {
  const health = await backupHealth(ownerDb, options)
  const reported = await reportBackupProblem(ownerDb, health)
  return { problem: backupProblemWords(health), caseCreated: reported?.created ?? false }
}
