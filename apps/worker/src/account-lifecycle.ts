import type { Db } from "@odentia/db"
import {
  claimLifecycleReminder,
  cleanupUnverifiedAccount,
  findLifecycleCandidates,
  type LifecycleCandidates,
  markLifecycleReminderSent,
  markLifecycleReminderUncertain,
} from "@odentia/services"

/** SMTP real cableado por el integrador (nunca log como fallback). */
export interface AccountLifecycleMailer {
  sendReminder(email: string, subject: string, body: string): Promise<void>
}

export interface AccountLifecycleOptions {
  notify: AccountLifecycleMailer
  now?: Date
  reminderDays?: number
  cleanupDays?: number
  limit?: number
}

export interface AccountLifecycleResult {
  reminders: number
  nudges: number
  cleaned: number
  errors: string[]
}

/**
 * Ciclo de cuentas (slice propio, sin Billing):
 * - No verificadas 3d: recordatorio informativo (claim durable ANTES del
 *   SMTP; tras el envío se marca sent; fallo → uncertain SIN reintento).
 * - No verificadas 30d sin relaciones: limpieza (verificación y borrado
 *   condicionado en su tx).
 * - Verificadas sin clínica: aviso distinto de onboarding (cómo crear o
 *   aceptar su clínica); jamás se borran ni reciben ventas: sin llamadas
 *   comerciales ni marketing supuesto.
 */
export async function runAccountLifecycleTick(
  ownerDb: Db,
  opts: AccountLifecycleOptions,
): Promise<AccountLifecycleResult> {
  const now = opts.now ?? new Date()
  const result: AccountLifecycleResult = { reminders: 0, nudges: 0, cleaned: 0, errors: [] }
  let candidates: LifecycleCandidates
  try {
    candidates = await findLifecycleCandidates(ownerDb, {
      now,
      reminderDays: opts.reminderDays,
      cleanupDays: opts.cleanupDays,
      limit: opts.limit,
    })
  } catch (error) {
    result.errors.push(`No se pudieron calcular candidatas: ${messageOf(error)}`)
    return result
  }
  for (const candidate of candidates.reminders) {
    try {
      const claimed = await ownerDb.transaction((tx) =>
        claimLifecycleReminder(tx, candidate.userId),
      )
      if (!claimed) continue
      try {
        await opts.notify.sendReminder(
          candidate.email,
          "Completa tu cuenta de odentIA",
          [
            "Hola: creaste una cuenta en odentIA pero aún no la verificaste ni pertenece a ninguna clínica.",
            "Si quieres usarla, verifica tu correo desde el enlace que te enviamos al registrarte.",
            "Si no la necesitas, no hagas nada: la cuenta se eliminará automáticamente a los 30 días.",
            "Este es un aviso informativo, no publicidad.",
          ].join("\n"),
        )
      } catch (error) {
        await ownerDb.transaction((tx) => markLifecycleReminderUncertain(tx, candidate.userId))
        result.errors.push(`Recordatorio ${candidate.email}: ${messageOf(error)}`)
        continue
      }
      await ownerDb.transaction((tx) => markLifecycleReminderSent(tx, candidate.userId))
      result.reminders += 1
    } catch (error) {
      result.errors.push(`Recordatorio ${candidate.email}: ${messageOf(error)}`)
    }
  }
  for (const candidate of candidates.nudges) {
    try {
      const claimed = await ownerDb.transaction((tx) =>
        claimLifecycleReminder(tx, candidate.userId, "onboarding_sin_clinica"),
      )
      if (!claimed) continue
      try {
        await opts.notify.sendReminder(
          candidate.email,
          "Tu cuenta de odentIA está verificada: crea o acepta tu clínica",
          [
            "Hola: tu cuenta ya está verificada pero aún no pertenece a ninguna clínica.",
            "Puedes crear tu clínica desde el panel o aceptar la invitación que te hayan enviado.",
            "Este es un aviso informativo, no publicidad.",
          ].join("\n"),
        )
      } catch (error) {
        await ownerDb.transaction((tx) => markLifecycleReminderUncertain(tx, candidate.userId))
        result.errors.push(`Aviso ${candidate.email}: ${messageOf(error)}`)
        continue
      }
      await ownerDb.transaction((tx) => markLifecycleReminderSent(tx, candidate.userId))
      result.nudges += 1
    } catch (error) {
      result.errors.push(`Aviso ${candidate.email}: ${messageOf(error)}`)
    }
  }
  for (const candidate of candidates.cleanups) {
    try {
      const deleted = await ownerDb.transaction((tx) =>
        cleanupUnverifiedAccount(tx, null, candidate.userId, { now }),
      )
      if (deleted.deleted) result.cleaned += 1
    } catch (error) {
      result.errors.push(`Limpieza ${candidate.email}: ${messageOf(error)}`)
    }
  }
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido"
}
