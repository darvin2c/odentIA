import { type Db, withOrgContext } from "@odentia/db"
import { leaveRegistrationHold, RegistrationHeld } from "@odentia/services"

/**
 * Un alta desde fuera con el documento de alguien que ya está en la clínica
 * (`RegistrationHeld`) revierte su transacción: lo que queda para recepción
 * se guarda aquí, en otra, antes de responder el texto neutro. Si no se
 * puede guardar, la respuesta es la misma: quien se registra no sabe nada más.
 */
export async function keepRegistrationHold(db: Db, orgId: string, error: unknown): Promise<void> {
  if (!(error instanceof RegistrationHeld)) return
  await withOrgContext(db, orgId, (tx) => leaveRegistrationHold(tx, orgId, error.hold)).catch((failure: unknown) => {
    console.error(`registro: pendiente para recepción sin guardar (${failure instanceof Error ? failure.name : "error"})`)
  })
}
