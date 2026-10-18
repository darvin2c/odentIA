import type { Db } from "@odentia/db"
import { supportCase, supportMessage } from "@odentia/db/schema/admin-support"
import { organization } from "@odentia/db/schema/auth"
import { and, eq, isNull, ne, sql } from "drizzle-orm"
import { enqueueSupportInboxNotice } from "./support-notices.js"

/* ---------- «Modelo sin responder»: el caso automático en Soporte ---------- */

/**
 * Quien abre un caso automático: odentIA, no una persona de la clínica. El
 * caso no tiene organización ni autor (`support_case_opener_check`), así que
 * ninguna clínica lo ve: el motivo técnico (una clave, el saldo, un rechazo
 * del proveedor) es de odentIA y la clínica no puede arreglarlo.
 */
export const AUTOMATIC_CASE_ROLE = "Automático"

const TITLE = "Modelo sin responder"

export interface ModelOutageReport {
  orgId: string
  /** Modelo que no responde (el que escribe o el de decisión) y su nombre en pantalla. */
  llm: string
  llmLabel: string
  /** Clase del problema (`API_KEY_REQUIRED`, `PROVIDER_REJECTED`, `PROVIDER_QUOTA`). */
  code: string
  /** Detalle técnico: va a soporte, nunca a la clínica. */
  detail: string
  /** Desde cuándo: el intento que falló. */
  at: Date
}

/** Una clínica de la lista del caso: su nombre y su id, para no repetirla. */
const clinicMarker = (orgId: string) => `[${orgId}]`

/**
 * Avisa a odentIA que un modelo no responde. Un mismo motivo (modelo y clase
 * de problema) es un solo caso abierto, aunque afecte a varias clínicas: cada
 * clínica nueva se anota en el caso y su título las nombra. Abrirlo deja el
 * correo «Caso nuevo» al buzón de soporte. Corre con owner (el caso no es de
 * ninguna clínica) y bajo un candado por motivo, para que dos corridas a la
 * vez no abran dos casos. Resuelto el caso, el siguiente fallo abre otro.
 */
export async function reportModelOutage(ownerDb: Db, report: ModelOutageReport): Promise<{ caseId: string; created: boolean }> {
  const dedupeKey = `modelo-sin-responder:${report.llm}:${report.code}`
  return ownerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`)
    const [org] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, report.orgId)).limit(1)
    const clinic = org?.name ?? report.orgId
    const line = `${clinic} ${clinicMarker(report.orgId)} · ${report.llmLabel} no responde desde ${report.at.toISOString()}: ${report.detail}`.slice(0, 4000)
    const [open] = await tx
      .select()
      .from(supportCase)
      .where(
        and(
          isNull(supportCase.organizationId),
          isNull(supportCase.openedBy),
          eq(supportCase.dedupeKey, dedupeKey),
          ne(supportCase.status, "resuelto"),
        ),
      )
      .limit(1)
    if (!open) {
      const [row] = await tx
        .insert(supportCase)
        .values({
          organizationId: null,
          kind: "problema",
          question: `${TITLE} · ${clinic}`.slice(0, 500),
          detail: `${report.llmLabel} (${report.code}): ${report.detail}`.slice(0, 500),
          screen: "/agent",
          role: AUTOMATIC_CASE_ROLE,
          dedupeKey,
          openedBy: null,
        })
        .returning({ id: supportCase.id })
      if (!row) throw new Error("No se pudo abrir el caso automático")
      await tx.insert(supportMessage).values({ caseId: row.id, organizationId: null, authorKind: "sistema", body: line, isInternal: true })
      await enqueueSupportInboxNotice(tx as Db, { caseId: row.id, organizationId: null, kind: "caso_nuevo", sourceId: row.id })
      return { caseId: row.id, created: true }
    }
    const [listed] = await tx
      .select({ id: supportMessage.id })
      .from(supportMessage)
      .where(and(eq(supportMessage.caseId, open.id), eq(supportMessage.authorKind, "sistema"), sql`strpos(${supportMessage.body}, ${clinicMarker(report.orgId)}) > 0`))
      .limit(1)
    if (listed) return { caseId: open.id, created: false }
    await tx.insert(supportMessage).values({ caseId: open.id, organizationId: null, authorKind: "sistema", body: line, isInternal: true })
    const question = `${open.question}, ${clinic}`
    await tx
      .update(supportCase)
      .set({ question: question.length > 500 ? `${question.slice(0, 497)}…` : question, updatedAt: new Date() })
      .where(eq(supportCase.id, open.id))
    return { caseId: open.id, created: false }
  })
}
