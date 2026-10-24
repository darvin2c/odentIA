import type { Db } from "@odentia/db"
import { supportInboxNoticeTemplate, supportReplyNoticeTemplate } from "@odentia/mail"
import {
  type ClaimedSupportNotice,
  claimSupportNotice,
  clinicOrigin,
  completeSupportNotice,
  tickSupportNotices,
} from "@odentia/services"

/** Envío mínimo compatible con el Mailer de `@odentia/mail`. */
export interface SupportMailSender {
  send(message: { to: string; subject: string; html: string; text: string }): Promise<void>
}

export interface SupportNoticeWorkerDeps {
  ownerDb: Db
  mailer?: SupportMailSender
  /** Buzón de soporte; vacío deja pendientes los avisos a soporte. */
  supportInbox: string
  /** Origen del back-office («Abrir en Soporte»). */
  adminUrl: string
  /** Origen del panel: casos de acceso, que no son de una clínica. */
  webUrl: string
  now?: Date
}

export interface SupportNoticeTickResult {
  mailed: number
  uncertain: number
  pending: number
}

/** El enlace del botón: Soporte en el back-office, o Ayuda en «Tus casos con soporte». */
export function supportNoticeLink(
  notice: Pick<ClaimedSupportNotice, "kind" | "caseId" | "clinicSlug" | "clinicProduct">,
  urls: { adminUrl: string; webUrl: string },
): string | null {
  const caso = encodeURIComponent(notice.caseId)
  if (notice.kind === "caso_nuevo" || notice.kind === "clinica_respondio") {
    return `${urls.adminUrl.replace(/\/+$/, "")}/support?caso=${caso}`
  }
  if (!notice.clinicSlug) return `${urls.webUrl.replace(/\/+$/, "")}/support?caso=${caso}`
  const origin = clinicOrigin(notice.clinicSlug, notice.clinicProduct ?? "dental")
  return origin ? `${origin}/home?ayuda=casos&caso=${caso}` : null
}

/**
 * Una vuelta: deja los avisos a quien preguntó que ya vencieron y envía los
 * pendientes. Reclamo durable ANTES del SMTP: si el envío falla queda
 * incierto y no se reintenta; si el worker cae entre reclamo y envío, queda
 * reclamado para revisarlo a mano.
 */
export async function runSupportNoticesTick(deps: SupportNoticeWorkerDeps): Promise<SupportNoticeTickResult> {
  const notices = await tickSupportNotices(deps.ownerDb, deps.now)
  const result: SupportNoticeTickResult = { mailed: 0, uncertain: 0, pending: 0 }
  if (!deps.mailer) {
    result.pending = notices.length
    if (notices.length > 0) console.log(`worker: soporte sin mailer; ${notices.length} avisos pendientes`)
    return result
  }
  for (const notice of notices) {
    if (notice.inbox && !deps.supportInbox) {
      result.pending += 1
      continue
    }
    const claimed = await claimSupportNotice(deps.ownerDb, notice.id)
    if (!claimed) continue
    try {
      const url = supportNoticeLink(claimed, deps)
      if (!url) throw new Error("sin dirección de la clínica para el enlace")
      const mail =
        claimed.kind === "caso_nuevo" || claimed.kind === "clinica_respondio"
          ? supportInboxNoticeTemplate({
              kind: claimed.kind,
              clinic: claimed.clinicName,
              caseKind: claimed.caseKind,
              screen: claimed.screen,
              who: claimed.who,
              role: claimed.role,
              url,
            })
          : supportReplyNoticeTemplate({ kind: claimed.kind, caseKind: claimed.caseKind, topic: claimed.topic, url })
      const to = claimed.to ?? deps.supportInbox
      await deps.mailer.send({ to, ...mail })
      await completeSupportNotice(deps.ownerDb, claimed.id, true)
      result.mailed += 1
    } catch (error) {
      const detail = error instanceof Error ? error.message : "fallo de envío"
      console.error(`worker: aviso de soporte incierto (${claimed.id})`, error)
      await completeSupportNotice(deps.ownerDb, claimed.id, false, detail)
      result.uncertain += 1
    }
  }
  if (result.pending > 0) {
    console.log(`worker: soporte sin SUPPORT_INBOX_EMAIL; ${result.pending} avisos a soporte pendientes`)
  }
  return result
}
