import { LEGAL } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { legalUpdateTemplate } from "@odentia/mail"
import { claimLegalNotices } from "@odentia/services"

export interface LegalNoticeDeps {
  ownerDb: Db
  mailer?: {
    send(message: { to: string; subject: string; html: string; text: string; replyTo?: string }): Promise<void>
  }
  /** Origen del panel: entrar es donde se aceptan. */
  webUrl: string
  /** Buzón que recibe a quien responde «no estoy de acuerdo»; sin él, se pide escribir desde Ayuda. */
  replyTo?: string | undefined
  now?: Date
  /** La versión vigente; por defecto la de `@odentia/auth`. */
  terms?: { version: string; effectiveAt: string; changes: readonly string[] }
}

/** «1 de marzo de 2027». */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`))
}

/**
 * Lienzo «Términos con Google», tablero 3: cuando cambia algo que importa en
 * los términos (hay `changes`), quienes aceptaron la versión anterior reciben un
 * correo antes de que rija. Después de esa fecha ya no se envía: al entrar
 * verán la ventana. Cada aviso se reserva antes de enviarlo.
 */
export async function runLegalNoticesTick(
  deps: LegalNoticeDeps,
): Promise<{ mailed: number; failed: number }> {
  const terms = deps.terms ?? LEGAL.terms
  const now = deps.now ?? new Date()
  const result = { mailed: 0, failed: 0 }
  if (!deps.mailer || terms.changes.length === 0) return result
  if (now.getTime() >= new Date(`${terms.effectiveAt}T00:00:00Z`).getTime()) return result
  const recipients = await claimLegalNotices(deps.ownerDb, terms.version)
  for (const r of recipients) {
    try {
      await deps.mailer.send({
        to: r.email,
        ...legalUpdateTemplate({
          firstName: r.firstName,
          effectiveText: longDate(terms.effectiveAt),
          changes: terms.changes,
          url: `${deps.webUrl.replace(/\/+$/, "")}/login`,
          replyTo: deps.replyTo,
        }),
      })
      result.mailed++
    } catch (error) {
      // Reservado y quizá enviado: no se repite.
      result.failed++
      console.error(`worker: aviso legal a ${r.userId} no confirmado`, error)
    }
  }
  return result
}
