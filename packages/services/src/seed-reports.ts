/**
 * Semilla manual de Reportes: dos meses de historia (citas, cobros, gastos y
 * conversaciones) para que cada cifra tenga con qué compararse. Son registros
 * del pasado y se insertan directo: la agenda no reserva hacia atrás ni fuera
 * de horario, y aquí no se envía ningún mensaje ni se activa nada.
 */
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { patientPayment } from "@odentia/db/schema/clinical"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { expense } from "@odentia/db/schema/finance"
import { eq } from "drizzle-orm"
import { getOrgLocale } from "./locale.js"
import { addMonths, currentMonthIn, monthStart } from "./report-periods.js"

interface ReportsSeedInput {
  orgId: string
  ownerUserId: string
  branchId: string
  contactId: string
  chairId: string
  dentistUserIds: string[]
  patientIds: string[]
}

/** Lo que pasó en un mes ya cerrado, contado hacia atrás desde el mes en curso. */
interface MonthPlan {
  monthsBack: number
  attended: number
  noShow: number
  cancelled: number
  /** Cobros en la unidad menor de la moneda de la clínica. */
  payments: Array<{ method: string; name: string; typeCode: string; cents: number }>
  expenses: Array<{ category: string; concept: string; cents: number }>
  /** Segundos hasta la primera respuesta de cada conversación; `null` si nadie respondió. */
  replies: Array<{ by: "agent" | "user"; seconds: number } | null>
}

const PLANS: MonthPlan[] = [
  {
    monthsBack: 1,
    attended: 24,
    noShow: 3,
    cancelled: 3,
    payments: [
      { method: "billetera", name: "Yape", typeCode: "68", cents: 15900_00 },
      { method: "efectivo", name: "Efectivo", typeCode: "10", cents: 14300_00 },
      { method: "tarjeta", name: "Tarjeta", typeCode: "48", cents: 12400_00 },
      { method: "transferencia", name: "Transferencia", typeCode: "30", cents: 5600_00 },
    ],
    expenses: [
      { category: "Personal", concept: "Planilla del mes", cents: 18600_00 },
      { category: "Laboratorio", concept: "Coronas y prótesis", cents: 4950_00 },
      { category: "Alquiler", concept: "Alquiler del local", cents: 3500_00 },
      { category: "Materiales", concept: "Insumos", cents: 2900_00 },
      { category: "Servicios", concept: "Luz, agua e internet", cents: 1500_00 },
    ],
    replies: [
      { by: "agent", seconds: 60 },
      { by: "agent", seconds: 90 },
      { by: "agent", seconds: 120 },
      { by: "agent", seconds: 180 },
      { by: "user", seconds: 420 },
      { by: "user", seconds: 600 },
      null,
    ],
  },
  {
    monthsBack: 2,
    attended: 19,
    noShow: 4,
    cancelled: 3,
    payments: [
      { method: "billetera", name: "Yape", typeCode: "68", cents: 13800_00 },
      { method: "efectivo", name: "Efectivo", typeCode: "10", cents: 15200_00 },
      { method: "tarjeta", name: "Tarjeta", typeCode: "48", cents: 11100_00 },
      { method: "transferencia", name: "Transferencia", typeCode: "30", cents: 4500_00 },
    ],
    expenses: [
      { category: "Personal", concept: "Planilla del mes", cents: 18600_00 },
      { category: "Laboratorio", concept: "Coronas y prótesis", cents: 4200_00 },
      { category: "Alquiler", concept: "Alquiler del local", cents: 3500_00 },
      { category: "Materiales", concept: "Insumos", cents: 2700_00 },
      { category: "Servicios", concept: "Luz, agua e internet", cents: 1500_00 },
    ],
    replies: [
      { by: "agent", seconds: 150 },
      { by: "agent", seconds: 240 },
      { by: "user", seconds: 540 },
      { by: "user", seconds: 720 },
      null,
    ],
  },
]

const SOURCES = ["recepcion", "recepcion", "agente", "recepcion", "enlace", "recepcion", "agente"]
const SERVICES = ["Limpieza dental", "Resina", "Evaluación", "Control", "Endodoncia"]

export async function seedReports(tx: Db, input: ReportsSeedInput): Promise<void> {
  const { timezone, currency } = await getOrgLocale(tx, input.orgId)
  const current = currentMonthIn(timezone)
  const [connection] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(eq(channelConnection.organizationId, input.orgId))
    .limit(1)

  for (const plan of PLANS) {
    const month = addMonths(current, -plan.monthsBack)
    const start = monthStart(timezone, month.year, month.month).getTime()
    // Cada cita en su propio hueco: día a día desde el 2, de 9 a 16 h, sin solaparse en el sillón.
    const slot = (index: number): Date => new Date(start + (1 + Math.floor(index / 8)) * 86_400_000 + (9 + (index % 8)) * 3_600_000)
    const statuses = [
      ...Array<string>(plan.attended).fill("atendida"),
      ...Array<string>(plan.noShow).fill("no_asistio"),
      ...Array<string>(plan.cancelled).fill("cancelada"),
    ]
    // Los pacientes rotan con un desfase por mes: así cada mes trae algunas primeras visitas.
    const offset = plan.monthsBack * 3
    await tx.insert(appointment).values(
      statuses.map((status, index) => {
        const startsAt = slot(index)
        return {
          organizationId: input.orgId,
          branchId: input.branchId,
          chairId: input.chairId,
          patientId: input.patientIds[(index + offset) % input.patientIds.length] as string,
          dentistUserId: input.dentistUserIds[index % input.dentistUserIds.length] as string,
          serviceName: SERVICES[index % SERVICES.length] as string,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          durationMin: 30,
          status,
          source: SOURCES[index % SOURCES.length] as string,
        }
      }),
    )

    const midMonth = new Date(start + 14 * 86_400_000 + 15 * 3_600_000)
    await tx.insert(patientPayment).values(
      plan.payments.map((payment, index) => ({
        organizationId: input.orgId,
        patientId: input.patientIds[index % input.patientIds.length] as string,
        branchId: input.branchId,
        amountCents: payment.cents,
        currency,
        paidAt: new Date(midMonth.getTime() + index * 86_400_000),
        method: payment.method,
        methodName: payment.name,
        methodTypeCode: payment.typeCode,
        createdBy: input.ownerUserId,
      })),
    )
    await tx.insert(expense).values(
      plan.expenses.map((item, index) => ({
        organizationId: input.orgId,
        branchId: input.branchId,
        concept: item.concept,
        category: item.category,
        amountCents: item.cents,
        currency,
        spentAt: new Date(midMonth.getTime() + index * 86_400_000),
        createdBy: input.ownerUserId,
      })),
    )

    if (!connection) continue
    for (const [index, reply] of plan.replies.entries()) {
      const inboundAt = new Date(start + (3 + index) * 86_400_000 + 16 * 3_600_000)
      const [thread] = await tx
        .insert(conversation)
        .values({
          organizationId: input.orgId,
          contactId: input.contactId,
          channelConnectionId: connection.id,
          externalThreadId: `seed-reportes-${plan.monthsBack}-${index}`,
          status: reply ? "closed" : "open",
          // Una cerrada dice cuándo y por qué (ADR 0024): la respondida se resolvió ese día.
          ...(reply ? { closedAt: new Date(inboundAt.getTime() + 3_600_000), closeReason: "resuelta" as const } : {}),
        })
        .returning({ id: conversation.id })
      if (!thread) continue
      await tx.insert(message).values({
        organizationId: input.orgId,
        conversationId: thread.id,
        direction: "in",
        senderKind: "contact",
        status: "received",
        body: "Hola, quisiera una cita",
        createdAt: inboundAt,
      })
      if (!reply) continue
      const sentAt = new Date(inboundAt.getTime() + reply.seconds * 1000)
      await tx.insert(message).values({
        organizationId: input.orgId,
        conversationId: thread.id,
        direction: "out",
        senderKind: reply.by,
        status: "sent",
        body: "Con gusto, ¿qué día le acomoda?",
        externalId: `seed-reportes-${plan.monthsBack}-${index}`,
        createdAt: sentAt,
        sentAt,
      })
    }
  }
}
