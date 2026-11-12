import { type Db, runOutsideReadOnly, withOrgContext } from "@odentia/db"
import { type ClinicalAccessResource, recordClinicalAccess } from "@odentia/services"

/**
 * Traza de una lectura clínica ya servida. Se registra después de responder
 * bien: una consulta rechazada o a un paciente inexistente no genera fila, y
 * un fallo de la traza no convierte una lectura ya servida en error.
 */
export async function traceClinicalRead(
  db: Db,
  input: { orgId: string; userId: string; patientId: string; resource: ClinicalAccessResource },
): Promise<void> {
  try {
    await withOrgContext(db, input.orgId, (tx) =>
      recordClinicalAccess(tx, input.orgId, input.userId, input.patientId, input.resource),
    )
  } catch (error) {
    console.error("No se pudo registrar la consulta a la historia clínica", {
      patientId: input.patientId,
      resource: input.resource,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Traza que se escribe antes de mostrar (soporte mirando la clínica): `false` si
 * no se pudo, y entonces no se muestra. Corre fuera del solo lectura del pedido:
 * es el sistema el que anota, no quien mira.
 */
export async function traceClinicalReadOrFail(
  db: Db,
  input: { orgId: string; userId: string; patientId: string; resource: ClinicalAccessResource },
): Promise<boolean> {
  try {
    await runOutsideReadOnly(() =>
      withOrgContext(db, input.orgId, (tx) =>
        recordClinicalAccess(tx, input.orgId, input.userId, input.patientId, input.resource),
      ),
    )
    return true
  } catch (error) {
    console.error("No se pudo registrar la consulta de soporte a la historia clínica", {
      patientId: input.patientId,
      resource: input.resource,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
