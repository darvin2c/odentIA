/**
 * La franja de avisos de la clínica (ADR 0065): qué avisos ve cada persona,
 * con qué texto y con qué acción. Una sola definición para la plataforma y el
 * selector de clínicas del panel; las pantallas solo los pintan.
 *
 * Va en la franja lo que afecta a toda la clínica, sigue siendo cierto hasta
 * que alguien actúa y tiene una acción que lo resuelve. Cada aviso tiene su
 * público según los permisos (`seesBilling`, `conversations.write`): quien
 * puede resolverlo ve la acción y los montos; el resto, qué cambia en su
 * trabajo y a quién avisar. Lo que no le toca a una persona no le llega.
 */
import type { Db } from "@odentia/db"
import { canAccess, seesBilling } from "@odentia/auth/permissions"
import { currencyFractionDigits } from "@odentia/clinical"
import { supportAccessGrant, supportCase } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { saasCharge, saasPayment, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm"
import { getOrgLocale } from "./locale.js"
import { type SaasAlert, getSaasAlerts } from "./saas-terms.js"

export type ClinicNoticeTone = "aviso" | "alarma" | "limite"

export type ClinicNoticeAction =
  | { kind: "pagar" | "elegir_plan" | "ver_plan" | "ver_consumo" | "subir_tope" | "escribir_soporte"; label: string; shortLabel: string }
  | { kind: "quitar_acceso"; label: string; shortLabel: string; grantId: string; caseId: string }

export interface ClinicNotice {
  /** Estable mientras el aviso sea el mismo: cambia al subir de nivel, y con él vuelve a verse. */
  id: string
  /** De qué trata: el selector y el menú de la clínica usan los de cobro. */
  topic: "cobro" | "tope" | "plan" | "soporte"
  tone: ClinicNoticeTone
  message: string
  short: string
  action: ClinicNoticeAction | null
  /** Cómo se cierra con la X: hasta que suba de nivel, por hoy, o no se cierra. */
  dismiss: "nivel" | "dia" | null
}

export interface NoticeViewer {
  userId: string
  role: string
}

const DAY = 86_400_000
const DISMISS: Record<ClinicNoticeTone, ClinicNotice["dismiss"]> = { aviso: "nivel", alarma: "dia", limite: null }

const PAY = { kind: "pagar", label: "Registrar pago", shortLabel: "Pagar" } as const
const CHOOSE = { kind: "elegir_plan", label: "Elegir plan", shortLabel: "Elegir" } as const
const SEE_PLAN = { kind: "ver_plan", label: "Ver mi plan", shortLabel: "Ver" } as const
const RAISE_CAP = { kind: "subir_tope", label: "Subir tope", shortLabel: "Subir" } as const
const SUPPORT = { kind: "escribir_soporte", label: "Escribir a soporte", shortLabel: "Soporte" } as const

const ALERT_ACTION: Record<SaasAlert["action"], ClinicNoticeAction> = {
  elegir_plan: CHOOSE,
  cambiar_tope: RAISE_CAP,
  ver_consumo: { kind: "ver_consumo", label: "Ver consumo", shortLabel: "Ver" },
  ver_plan: SEE_PLAN,
}

/** Avisos de la franja para esta persona en esta clínica, del más grave al más leve. */
export async function getClinicNotices(tx: Db, orgId: string, viewer: NoticeViewer, now = new Date()): Promise<ClinicNotice[]> {
  const billing = seesBilling(viewer.role)
  const attends = canAccess(viewer.role, "conversations.write")
  const notices: ClinicNotice[] = []

  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  const locale = await getOrgLocale(tx, orgId).catch(() => null)
  const lang = locale?.locale ?? "es"
  const timeZone = locale?.timezone ?? "UTC"
  const longDay = (date: Date) => new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", timeZone }).format(date)
  const shortDay = (date: Date) =>
    new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short", timeZone }).format(date).replace(/\./g, "")
  // El mes solo, en minúscula: algunas variantes regionales lo dan con mayúscula («Octubre»).
  const monthOf = (date: Date) => new Intl.DateTimeFormat(lang, { month: "long", timeZone: "UTC" }).format(date).toLocaleLowerCase(lang)
  // Con los decimales de la moneda (ISO 4217), no siempre dos.
  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat(lang, { style: "currency", currency, currencyDisplay: "code" }).format(cents / 10 ** currencyFractionDigits(currency))

  // A quién avisar cuando la persona no puede resolverlo: la primera propietaria.
  const [owner] = await tx
    .select({ name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
    .orderBy(asc(member.createdAt))
    .limit(1)
  const tellOwner = owner?.name ? `Avísale a ${owner.name.split(" ")[0]}.` : "Avísale a quien administra la clínica."

  if (sub && !sub.isDemo) {
    const openCharges = await tx
      .select()
      .from(saasCharge)
      .where(and(eq(saasCharge.organizationId, orgId), inArray(saasCharge.status, ["pendiente", "parcial"]), isNull(saasCharge.voidedAt)))
      .orderBy(asc(saasCharge.dueAt))
    const [pendingPayment] = await tx
      .select({ id: saasPayment.id })
      .from(saasPayment)
      .where(and(eq(saasPayment.organizationId, orgId), eq(saasPayment.status, "pendiente")))
      .limit(1)
    const inReview = Boolean(pendingPayment)
    const next = openCharges[0]
    const owed = next ? money(next.amountCents - next.paidCents, next.currency) : null

    if (sub.status === "restringida") {
      const noPlan = sub.restrictReason === "sin_plan"
      notices.push(
        billing
          ? {
              id: `estado:restringida:${sub.restrictReason ?? ""}`,
              topic: "cobro",
              tone: "limite",
              message: noPlan
                ? "La prueba terminó: la clínica está en solo lectura hasta que elijas un plan. No se pierde ningún dato."
                : `La clínica está en solo lectura: falta pagar ${next ? `el cargo de ${monthOf(next.periodStart)} (${owed})` : "un cargo"}. Sofi no responde.`,
              short: noPlan ? "Solo lectura: elige un plan" : "Solo lectura: falta un pago",
              action: noPlan ? CHOOSE : PAY,
              dismiss: null,
            }
          : {
              id: `estado:restringida:${sub.restrictReason ?? ""}`,
              topic: "cobro",
              tone: "limite",
              message: `La clínica está en solo lectura ${noPlan ? "hasta que se elija un plan" : "por un pago pendiente"}: puedes ver todo, pero no guardar. ${tellOwner}`,
              short: "La clínica está en solo lectura",
              action: null,
              dismiss: null,
            },
      )
    } else if (sub.status === "pausada") {
      const why = sub.pauseReason ? ` Motivo: ${sub.pauseReason}.` : ""
      notices.push({
        id: "estado:pausada",
        topic: "cobro",
        tone: "limite",
        message: billing
          ? `odentIA puso la clínica en pausa: se puede ver todo, pero no guardar.${why}`
          : `La clínica está en pausa: puedes ver todo, pero no guardar. ${tellOwner}`,
        short: "La clínica está en pausa",
        action: billing ? SUPPORT : null,
        dismiss: null,
      })
    } else if (sub.status === "cancelada") {
      notices.push({
        id: "estado:cancelada",
        topic: "cobro",
        tone: "limite",
        message: billing
          ? "La suscripción está cancelada: la clínica queda en solo lectura. Tus cargos y comprobantes siguen en Plan y pagos."
          : "La clínica está cancelada: puedes ver todo, pero no guardar.",
        short: "Suscripción cancelada",
        action: billing ? SEE_PLAN : null,
        dismiss: null,
      })
    } else if (sub.status === "gracia") {
      const graceEnds = sub.graceEndsAt
      const tomorrow = graceEnds !== null && graceEnds.getTime() - now.getTime() <= DAY
      if (inReview) {
        if (billing) notices.push(reviewNotice())
      } else if (!next) {
        // Gracia al terminar la prueba sin plan: no hay cargo, falta elegir el plan.
        if (billing)
          notices.push({
            id: `gracia:sin-plan:${graceEnds?.toISOString().slice(0, 10) ?? ""}`,
            topic: "cobro",
            tone: "alarma",
            message: `Tu prueba terminó: tienes hasta el ${graceEnds ? longDay(graceEnds) : "fin de la gracia"} para elegir tu plan.`,
            short: graceEnds ? `Elige tu plan antes del ${shortDay(graceEnds)}` : "Elige tu plan",
            action: CHOOSE,
            dismiss: "dia",
          })
      } else if (billing) {
        notices.push({
          id: `gracia:${next.id}`,
          topic: "cobro",
          tone: "alarma",
          message: `Venció tu cargo de ${monthOf(next.periodStart)} (${owed}).${graceEnds ? ` ${tomorrow ? "Mañana" : `El ${longDay(graceEnds)}`} la clínica pasa a solo lectura si no se registra el pago.` : ""}`,
          short: graceEnds ? `Pasa a solo lectura el ${shortDay(graceEnds)}` : "Tienes un cargo vencido",
          action: PAY,
          dismiss: "dia",
        })
      } else if (tomorrow) {
        // El resto del equipo se entera solo el día antes: puede avisar a quien paga.
        notices.push({
          id: `gracia:manana:${next.id}`,
          topic: "cobro",
          tone: "alarma",
          message: `Mañana la clínica pasa a solo lectura por un pago pendiente. ${tellOwner}`,
          short: "Mañana pasa a solo lectura",
          action: null,
          dismiss: "dia",
        })
      }
    } else if (billing && (sub.status === "activa" || sub.status === "prueba")) {
      // El cargo vence 7 días después de emitirse: se avisa desde que llega.
      if (inReview) notices.push(reviewNotice())
      else if (next?.dueAt && next.dueAt.getTime() > now.getTime()) {
        const left = next.dueAt.getTime() - now.getTime()
        const soon = left <= 2 * DAY
        notices.push({
          id: `cargo:${next.id}:${soon ? "alarma" : "aviso"}`,
          topic: "cobro",
          tone: soon ? "alarma" : "aviso",
          message: `Tu cargo de ${monthOf(next.periodStart)} (${owed}) vence ${soon && left <= DAY ? "mañana" : "el"} ${longDay(next.dueAt)}.`,
          short: `Tu cargo vence el ${shortDay(next.dueAt)}`,
          action: PAY,
          dismiss: soon ? "dia" : "nivel",
        })
      }
    }

    // Prueba, crédito, tope, precio especial y Fundadores: los calcula el
    // servidor al leer (ADR 0031). Solo quien administra, salvo el tope
    // alcanzado, que cambia el trabajo de quien atiende conversaciones.
    if (sub.status === "prueba" || sub.status === "activa" || sub.status === "gracia") {
      if (billing || attends) {
        const alerts = await getSaasAlerts(tx, orgId, now)
        for (const alert of alerts) {
          const id = `${alert.family}:${alert.level}:${alert.periodKey}`
          if (alert.family === "tope" && alert.level === "limite" && !billing) {
            notices.push({
              id,
              topic: "tope",
              tone: "limite",
              message: `Llegaron al tope de gasto del mes: Sofi no atiende casos nuevos; te llegan a ti. ${tellOwner}`,
              short: "Tope de gasto: los casos nuevos te llegan a ti",
              action: null,
              dismiss: null,
            })
            continue
          }
          if (!billing) continue
          // Que se acabe el crédito no detiene nada: solo informa.
          const tone: ClinicNoticeTone = alert.family === "credito" ? "aviso" : alert.level
          notices.push({
            id,
            topic: alert.family === "tope" ? "tope" : "plan",
            tone,
            message: alert.message,
            short: alert.short,
            action: ALERT_ACTION[alert.action],
            dismiss: DISMISS[tone],
          })
        }
      }
    }
  }

  // Soporte con acceso: solo propietario y administrador, que pueden darlo y quitarlo.
  if (billing) {
    const grants = await tx
      .select({
        id: supportAccessGrant.id,
        caseId: supportAccessGrant.caseId,
        expiresAt: supportAccessGrant.expiresAt,
        grantedBy: supportAccessGrant.grantedBy,
        grantedByName: user.name,
        question: supportCase.question,
      })
      .from(supportAccessGrant)
      .leftJoin(user, eq(user.id, supportAccessGrant.grantedBy))
      .leftJoin(supportCase, eq(supportCase.id, supportAccessGrant.caseId))
      .where(and(eq(supportAccessGrant.organizationId, orgId), isNull(supportAccessGrant.revokedAt), gt(supportAccessGrant.expiresAt, now)))
      .orderBy(asc(supportAccessGrant.expiresAt))
      .limit(5)
    const hour = (date: Date) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", timeZone }).format(date)
    for (const grant of grants) {
      const who = grant.grantedBy === viewer.userId ? "Diste" : `${grant.grantedByName?.split(" ")[0] ?? "Alguien del equipo"} dio`
      const why = grant.question ? ` por el caso «${grant.question.length > 60 ? `${grant.question.slice(0, 60)}…` : grant.question}»` : ""
      notices.push({
        id: `soporte:${grant.id}`,
        topic: "soporte",
        tone: "aviso",
        message: `${who} acceso a soporte de odentIA hasta las ${hour(grant.expiresAt)}${why}. Solo ve la configuración, no pacientes.`,
        short: `Soporte tiene acceso hasta las ${hour(grant.expiresAt)}`,
        action: { kind: "quitar_acceso", label: "Quitar acceso", shortLabel: "Quitar", grantId: grant.id, caseId: grant.caseId },
        dismiss: "nivel",
      })
    }
  }

  const order: Record<ClinicNoticeTone, number> = { limite: 0, alarma: 1, aviso: 2 }
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => order[a.notice.tone] - order[b.notice.tone] || a.index - b.index)
    .map(({ notice }) => notice)
}

function reviewNotice(): ClinicNotice {
  return {
    id: "cobro:en-revision",
    topic: "cobro",
    tone: "aviso",
    message: "odentIA está revisando tu pago. Mientras tanto la clínica sigue igual.",
    short: "odentIA está revisando tu pago",
    action: SEE_PLAN,
    dismiss: "nivel",
  }
}
