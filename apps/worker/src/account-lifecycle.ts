import type { Db } from "@odentia/db"
import { accountReminderTemplate, type MailTemplate } from "@odentia/mail"
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
  sendReminder(email: string, mail: MailTemplate): Promise<void>
}

export interface AccountLifecycleOptions {
  notify: AccountLifecycleMailer
  /** Dónde se crea la clínica: el botón del aviso a una cuenta verificada sin clínica. */
  onboardingUrl: string
  /** Enlace nuevo de verificación de Better Auth: el botón del recordatorio a una cuenta sin verificar. */
  verificationUrl: (email: string) => Promise<string>
  /** Días que sirve ese enlace; el correo lo dice. */
  verificationDays: number
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
 * - No verificadas 3d: recordatorio informativo con un enlace nuevo para
 *   verificar (claim durable ANTES del SMTP; tras el envío se marca sent;
 *   fallo → uncertain SIN reintento).
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
      // Antes de reclamar: si el enlace no se puede armar, el recordatorio queda para la próxima vuelta.
      const url = await opts.verificationUrl(candidate.email)
      const claimed = await ownerDb.transaction((tx) =>
        claimLifecycleReminder(tx, candidate.userId),
      )
      if (!claimed) continue
      try {
        await opts.notify.sendReminder(
          candidate.email,
          accountReminderTemplate({ kind: "sin_verificar", url, days: opts.verificationDays }),
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
          accountReminderTemplate({ kind: "sin_clinica", url: opts.onboardingUrl }),
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
