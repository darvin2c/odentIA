import type { Db } from "@odentia/db"
import {
  claimSaasNoticeMail,
  completeSaasNoticeMail,
  decideSaasAccess,
  type SaasTickMail,
  type SaasTickSummary,
  tickSaasBilling,
} from "@odentia/services"
import { sql } from "drizzle-orm"

/** Envío mínimo compatible con el Mailer de `@odentia/mail` (sin depender del paquete). */
export interface SaasMailSender {
  send(message: { to: string; subject: string; html: string; text: string }): Promise<void>
}

/**
 * Reloj comercial y avisos persistidos. El envío se reclama antes de SMTP:
 * un resultado incierto no se reintenta automáticamente. La ingesta entrante
 * no se bloquea por restricciones comerciales.
 */

export interface SaasBillingWorkerDeps {
  ownerDb: Db
  mailer?: SaasMailSender
  /** Origen del panel: el botón a Plan y pagos de cada aviso. */
  panelUrl?: string
}

export interface SaasBillingTickResult {
  summary: SaasTickSummary
  mailed: number
  pendingMail: number
}

/**
 * Reclamo durable ANTES del SMTP: solo el dueño del reclamo envía. Si el
 * envío falla se marca incierto (jamás reintenta ciego); si el worker cae
 * entre reclamo y envío, queda reclamado para conciliación manual.
 */
async function sendClaimedMail(
  ownerDb: Db,
  mailer: SaasMailSender,
  mail: SaasTickMail,
): Promise<"enviado" | "incierto" | "ajeno"> {
  const claimed = await claimSaasNoticeMail(ownerDb, mail.organizationId, mail.dedupeKey)
  if (!claimed) return "ajeno"
  try {
    await mailer.send({
      to: claimed.to,
      subject: claimed.subject,
      html: claimed.html,
      text: claimed.text,
    })
    await completeSaasNoticeMail(ownerDb, mail.organizationId, mail.dedupeKey, true)
    return "enviado"
  } catch (error) {
    const detail = error instanceof Error ? error.message : "fallo de envío"
    console.error(
      `worker: saas-billing correo incierto para ${mail.organizationId} (${mail.dedupeKey})`,
      error,
    )
    await completeSaasNoticeMail(ownerDb, mail.organizationId, mail.dedupeKey, false, detail)
    return "incierto"
  }
}

/**
 * Un ciclo del reloj SaaS: transiciones prueba(14d)→gracia(7d)→restringida
 * con avisos persistidos, y envío de los correos pendientes (uno por
 * dedupeKey; el envío ambiguo se concilia por `emailed_at`, no reintentando
 * el envío a ciegas).
 */
export async function runSaasBillingTick(
  deps: SaasBillingWorkerDeps,
): Promise<SaasBillingTickResult> {
  const nowResult: unknown = await deps.ownerDb.execute(sql`select now() as now`)
  let now = new Date()
  if (Array.isArray(nowResult)) {
    const first: unknown = nowResult[0]
    if (typeof first === "object" && first !== null && "now" in first) {
      const value: unknown = first.now
      if (value instanceof Date) now = value
      else if (typeof value === "string") now = new Date(value)
    }
  }
  const tick = await tickSaasBilling(deps.ownerDb, now, { panelUrl: deps.panelUrl })
  let mailed = 0
  let uncertain = 0
  for (const mail of tick.mails) {
    if (!deps.mailer) {
      console.log(
        `worker: saas-billing sin mailer; correo pendiente ${mail.dedupeKey} → ${mail.to}`,
      )
      continue
    }
    const outcome = await sendClaimedMail(deps.ownerDb, deps.mailer, mail)
    if (outcome === "enviado") mailed += 1
    if (outcome === "incierto") uncertain += 1
  }
  const pendingMail = tick.mails.length - mailed - uncertain
  console.log(
    `worker: saas-billing pruebas_por_terminar=${tick.summary.trialsEnding} ` +
      `a_gracia=${tick.summary.trialsEnded} gracias_vencidas=${tick.summary.gracesEnded} ` +
      `restringidas=${tick.summary.restricted} correos=${mailed} pendientes=${pendingMail} cargos=${tick.summary.chargesEnsured}`,
  )
  return { summary: tick.summary, mailed, pendingMail }
}

/** true si la org no puede enviar (restringida o pausada comercial). Demo e hilos sin suscripción envían. */
export async function isSaasSendBlocked(ownerDb: Db, orgId: string): Promise<boolean> {
  const decision = await decideSaasAccess(ownerDb, orgId, "enviar")
  return !decision.allowed
}

/** true si el tick de automatizaciones debe saltar la org (pausa/restricción comercial). */
export async function shouldSkipSaasOrg(ownerDb: Db, orgId: string): Promise<boolean> {
  return isSaasSendBlocked(ownerDb, orgId)
}
