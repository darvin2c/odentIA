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
import { canAccess, type OrgRole, roleLabel, seesBilling } from "@odentia/auth/permissions"
import { currencyFractionDigits } from "@odentia/clinical"
import { supportAccessGrant, supportCase } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { saasCharge, saasPayment, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm"
import { getOrgLocale, orgProduct, orgProductName } from "./locale.js"
import { accessRequestPendingSql } from "./support-case-rules.js"
import { readOnlyAtOf } from "./saas-billing.js"
import { type SaasAlert, getSaasAlerts } from "./saas-terms.js"

export type ClinicNoticeTone = "aviso" | "alarma" | "limite"

export type ClinicNoticeAction =
  | { kind: "pagar" | "elegir_plan" | "ver_plan" | "ver_consumo" | "subir_tope" | "escribir_soporte"; label: string; shortLabel: string }
  | { kind: "quitar_acceso"; label: string; shortLabel: string; grantId: string; caseId: string }
  | { kind: "revisar_acceso"; label: string; shortLabel: string; caseId: string }

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
  /** `false`: ve la facturación pero aún no pasó la verificación que pide la clínica (ADR 0107): sin importes. */
  billing?: boolean
}

const DAY = 86_400_000
const DISMISS: Record<ClinicNoticeTone, ClinicNotice["dismiss"]> = { aviso: "nivel", alarma: "dia", limite: null }

const PAY = { kind: "pagar", label: "Registrar pago", shortLabel: "Pagar" } as const
const CHOOSE = { kind: "elegir_plan", label: "Elegir plan", shortLabel: "Elegir" } as const
const SEE_PLAN = { kind: "ver_plan", label: "Ver mi plan", shortLabel: "Ver" } as const
const RAISE_CAP = { kind: "subir_tope", label: "Subir presupuesto", shortLabel: "Subir" } as const
const SUPPORT = { kind: "escribir_soporte", label: "Escribir a soporte", shortLabel: "Soporte" } as const

const ALERT_ACTION: Record<SaasAlert["action"], ClinicNoticeAction> = {
  elegir_plan: CHOOSE,
  cambiar_tope: RAISE_CAP,
  ver_consumo: { kind: "ver_consumo", label: "Ver consumo", shortLabel: "Ver" },
  ver_plan: SEE_PLAN,
}

/**
 * Cómo se nombra a alguien en «Avísale a …»: su primer nombre, con el tratamiento si lo trae
 * («Dra. Ana Torres» → «Dra. Ana»), y sin el punto del tratamiento al final, que con el de la
 * frase quedaría «Dra..».
 */
export function callName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0] ?? ""
  const called = first.endsWith(".") && words[1] ? `${first} ${words[1]}` : first
  return called.replace(/\.+$/, "")
}

/** Avisos de la franja para esta persona en esta clínica, del más grave al más leve. */
export async function getClinicNotices(tx: Db, orgId: string, viewer: NoticeViewer, now = new Date()): Promise<ClinicNotice[]> {
  const billing = seesBilling(viewer.role) && viewer.billing !== false
  const attends = canAccess(viewer.role, "conversations.write")
  const notices: ClinicNotice[] = []

  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  const locale = await getOrgLocale(tx, orgId).catch(() => null)
  const lang = locale?.locale ?? "es"
  // El servicio se nombra con la marca de la clínica (issue 229): odentIA o latidIA.
  const brand = await orgProductName(tx, orgId)
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
  const tellOwner = owner?.name ? `Avísale a ${callName(owner.name)}.` : "Avísale a quien administra la clínica."

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
    // Si el último comprobante de ese cargo se rechazó y el cargo sigue sin pagar, quien paga
    // lee por qué en el mismo aviso (la misma frase que «Próximo cobro» en Plan y pagos).
    const [lastProof] = next
      ? await tx
          .select({ id: saasPayment.id, status: saasPayment.status, filename: saasPayment.receiptFilename, reason: saasPayment.rejectReason })
          .from(saasPayment)
          .where(and(eq(saasPayment.organizationId, orgId), eq(saasPayment.chargeId, next.id)))
          .orderBy(desc(saasPayment.createdAt), desc(saasPayment.id))
          .limit(1)
      : []
    const rejected = lastProof?.status === "rechazado" ? lastProof : null
    const rejectedLine = rejected ? ` ${rejectedProofLine(rejected.filename, rejected.reason)}` : ""
    // Un aviso cerrado vuelve a verse cuando llega el rechazo.
    const rejectedKey = rejected ? `:rechazo:${rejected.id}` : ""

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
                : `La clínica está en solo lectura: falta pagar ${next ? `el cargo de ${monthOf(next.periodStart)} (${owed})` : "un cargo"}.${rejectedLine} Sofi no responde.`,
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
          ? `${brand} puso la clínica en pausa: se puede ver todo, pero no guardar.${why}`
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
      // Un solo día de solo lectura, el del ciclo y el del correo de la víspera: el fin de la
      // gracia o la prórroga vigente de un comprobante. Un comprobante en revisión no lo aplaza.
      const readOnlyAt = readOnlyAtOf(sub, now)
      const left = readOnlyAt ? readOnlyAt.getTime() - now.getTime() : null
      // «Mañana» solo si faltan entre 0 y 24 horas; pasada la hora (el ciclo aún no corrió), «Hoy»:
      // nunca una fecha que ya pasó.
      const due = left === null ? null : left <= 0 ? "hoy" : left <= DAY ? "manana" : "dia"
      const when = readOnlyAt ? (due === "hoy" ? "Hoy" : due === "manana" ? "Mañana" : `El ${longDay(readOnlyAt)}`) : null
      const shortWhen = !readOnlyAt ? null : due === "hoy" ? "hoy pasa a solo lectura" : `solo lectura el ${shortDay(readOnlyAt)}`
      if (inReview) {
        if (billing) {
          notices.push(
            readOnlyAt
              ? {
                  // Otro id por día: si cambia la fecha, el aviso vuelve a verse.
                  id: `cobro:en-revision:gracia:${readOnlyAt.toISOString().slice(0, 10)}`,
                  topic: "cobro",
                  tone: due === "dia" ? "aviso" : "alarma",
                  message: `${brand} está revisando tu pago. ${when} la clínica pasa a solo lectura si el pago no se confirma antes.`,
                  short: `${brand} revisa tu pago · ${shortWhen}`,
                  action: SEE_PLAN,
                  dismiss: due === "dia" ? "nivel" : "dia",
                }
              : reviewNotice(brand),
          )
        } else if (next && (due === "manana" || due === "hoy")) {
          notices.push(teamNotice(next.id, when ?? "Mañana", tellOwner))
        }
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
          id: `gracia:${next.id}${rejectedKey}`,
          topic: "cobro",
          tone: "alarma",
          message: `Venció tu cargo de ${monthOf(next.periodStart)} (${owed}).${rejectedLine}${when ? ` ${when} la clínica pasa a solo lectura si no se registra el pago.` : ""}`,
          short: readOnlyAt ? (due === "hoy" ? "Hoy pasa a solo lectura" : `Pasa a solo lectura el ${shortDay(readOnlyAt)}`) : "Tienes un cargo vencido",
          action: PAY,
          dismiss: "dia",
        })
      } else if (due === "manana" || due === "hoy") {
        // El resto del equipo se entera solo el día antes: puede avisar a quien paga.
        notices.push(teamNotice(next.id, when ?? "Mañana", tellOwner))
      }
    } else if (billing && (sub.status === "activa" || sub.status === "prueba")) {
      // El cargo vence 7 días después de emitirse: se avisa desde que llega.
      if (inReview) notices.push(reviewNotice(brand))
      else if (next?.dueAt && next.dueAt.getTime() > now.getTime()) {
        const left = next.dueAt.getTime() - now.getTime()
        const soon = left <= 2 * DAY
        notices.push({
          id: `cargo:${next.id}:${soon ? "alarma" : "aviso"}${rejectedKey}`,
          topic: "cobro",
          tone: soon ? "alarma" : "aviso",
          message: `Tu cargo de ${monthOf(next.periodStart)} (${owed}) vence ${soon && left <= DAY ? "mañana" : "el"} ${longDay(next.dueAt)}.${rejectedLine}`,
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
              message: `La clínica llegó a su presupuesto del mes: Sofi te pasa las conversaciones nuevas y Clío no escucha en las atenciones nuevas. ${tellOwner}`,
              short: "Presupuesto del mes: las conversaciones nuevas te llegan a ti",
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

  // Soporte con acceso: lo ve todo el equipo, sin la X mientras dura (no se esconde lo que
  // sigue abierto); quitarlo, solo la propietaria y los administradores. No copia el texto del
  // caso: puede nombrar pacientes. Uno solo vigente por clínica.
  const grants = await tx
    .select({
      id: supportAccessGrant.id,
      caseId: supportAccessGrant.caseId,
      scope: supportAccessGrant.scope,
      viewRole: supportAccessGrant.viewRole,
      expiresAt: supportAccessGrant.expiresAt,
      grantedBy: supportAccessGrant.grantedBy,
      grantedByName: user.name,
    })
    .from(supportAccessGrant)
    .leftJoin(user, eq(user.id, supportAccessGrant.grantedBy))
    .where(and(eq(supportAccessGrant.organizationId, orgId), isNull(supportAccessGrant.revokedAt), gt(supportAccessGrant.expiresAt, now)))
    .orderBy(asc(supportAccessGrant.expiresAt))
    .limit(1)
  const hour = (date: Date) => new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit", timeZone }).format(date)
  const product = await orgProduct(tx, orgId)
  const canManage = viewer.role === "owner" || viewer.role === "admin"
  for (const grant of grants) {
    const who = grant.grantedBy === viewer.userId ? "Lo diste tú" : `Lo dio ${grant.grantedByName ?? "alguien del equipo"}`
    const what = grant.scope === "rol" && grant.viewRole ? `mirar como ${roleLabel(grant.viewRole as OrgRole, product)}` : "mirar la configuración"
    notices.push({
      id: `soporte:${grant.id}`,
      topic: "soporte",
      tone: "aviso",
      message: `Soporte de ${brand} puede ${what} hasta las ${hour(grant.expiresAt)}. ${who}; no puede cambiar nada.`,
      short: `Soporte: ${what.replace("mirar ", "")} · hasta ${hour(grant.expiresAt)}`,
      action: canManage
        ? { kind: "quitar_acceso", label: "Quitar acceso", shortLabel: "Quitar", grantId: grant.id, caseId: grant.caseId }
        : null,
      dismiss: null,
    })
  }

  // Un pedido de soporte sin responder: a quien puede autorizarlo, con «Revisar». Este sí se
  // cierra por hoy: todavía no hay nada abierto, y el pedido sigue en Ayuda y en el correo.
  if (canManage && grants.length === 0) {
    const requests = await tx
      .select({ id: supportCase.id, role: supportCase.accessRequestedRole, minutes: supportCase.accessRequestedMinutes })
      .from(supportCase)
      .where(and(eq(supportCase.organizationId, orgId), isNotNull(supportCase.accessRequestedAt), ne(supportCase.status, "resuelto"), accessRequestPendingSql))
      .orderBy(desc(supportCase.accessRequestedAt))
      .limit(1)
    for (const request of requests) {
      const what = request.role ? `mirar como ${roleLabel(request.role as OrgRole, product)}` : "mirar la configuración"
      notices.push({
        id: `soporte-pedido:${request.id}`,
        topic: "soporte",
        tone: "aviso",
        message: `Soporte de ${brand} pide ${what}${request.minutes ? `, ${request.minutes} minutos` : ""}.`,
        short: `Soporte pide ${what.replace("mirar ", "")}`,
        action: { kind: "revisar_acceso", label: "Revisar", shortLabel: "Revisar", caseId: request.id },
        dismiss: "dia",
      })
    }
  }

  const order: Record<ClinicNoticeTone, number> = { limite: 0, alarma: 1, aviso: 2 }
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => order[a.notice.tone] - order[b.notice.tone] || a.index - b.index)
    .map(({ notice }) => notice)
}

/**
 * «No pudimos confirmar tu comprobante «demo.png»: motivo.»: lo que lee la clínica cuando la
 * administración rechazó su último comprobante del cargo. No promete correo: no lo hay.
 */
function rejectedProofLine(filename: string | null, reason: string | null): string {
  const why = (reason ?? "").trim().replace(/[.\s]+$/, "")
  return `No pudimos confirmar tu comprobante${filename ? ` «${filename}»` : ""}${why ? `: ${why}` : ""}.`
}

/** Para quien no paga, el día antes (o el mismo día): sin montos y con a quién avisar. */
function teamNotice(chargeId: string, when: string, tellOwner: string): ClinicNotice {
  return {
    id: `gracia:manana:${chargeId}`,
    topic: "cobro",
    tone: "alarma",
    message: `${when} la clínica pasa a solo lectura por un pago pendiente. ${tellOwner}`,
    short: `${when} pasa a solo lectura`,
    action: null,
    dismiss: "dia",
  }
}

function reviewNotice(brand: string): ClinicNotice {
  return {
    id: "cobro:en-revision",
    topic: "cobro",
    tone: "aviso",
    message: `${brand} está revisando tu pago. Mientras tanto la clínica sigue igual.`,
    short: `${brand} está revisando tu pago`,
    action: SEE_PLAN,
    dismiss: "nivel",
  }
}
