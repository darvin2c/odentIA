/**
 * Semilla de las fases 5 y 6 de Reportes (ADR 0070 y 0071): dos respuestas de
 * Argos fijadas en el Resumen y las metas de cobrado y de pacientes nuevos,
 * con una meta anterior para que se vea que cambiarla no reescribe los meses
 * pasados. Solo CLI de desarrollo (`seed-dev.ts`): nunca en pruebas ni CI.
 * No prende el resumen del lunes: nace apagado y lo prende cada persona.
 */
import type { Db } from "@odentia/db"
import { reportGoal, reportPin } from "@odentia/db/schema/reports"
import { formatMoney } from "@odentia/clinical"
import { collectedNetMany } from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { addMonths, currentMonthIn, monthStart } from "./report-periods.js"
import { newPatientsMany } from "./reports.js"

export interface ReportsArgosSeedInput {
  orgId: string
  ownerUserId: string
  professionalUserId: string
}

function firstDay(value: { year: number; month: number }): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}-01`
}

export async function seedReportsArgos(tx: Db, input: ReportsArgosSeedInput): Promise<{ pins: number; goalText: string }> {
  const { orgId } = input
  const { timezone, currency, locale } = await getOrgLocale(tx, orgId)
  const now = new Date()
  const current = currentMonthIn(timezone, now)
  const last = addMonths(current, -1)
  const lastSpan = { start: monthStart(timezone, last.year, last.month), end: monthStart(timezone, current.year, current.month) }
  const [collected] = await collectedNetMany(tx, orgId, [lastSpan])
  const lastCents = collected?.find((item) => item.currency === currency)?.cents ?? 0
  const [lastNew] = await newPatientsMany(tx, orgId, { branch: null }, [lastSpan])
  // La meta de este mes: un 10 % más que lo cobrado el mes pasado, redondeada a miles; la de antes, más baja.
  const thousand = 100_000
  const goal = Math.max(thousand, Math.ceil((lastCents * 1.1) / thousand) * thousand)
  const before = Math.max(thousand, Math.round((goal * 0.85) / thousand) * thousand)
  await tx.insert(reportGoal).values([
    { organizationId: orgId, metric: "cobrado", fromMonth: firstDay(addMonths(current, -3)), amount: before, currency, setBy: input.ownerUserId },
    { organizationId: orgId, metric: "cobrado", fromMonth: firstDay(current), amount: goal, currency, setBy: input.ownerUserId },
    { organizationId: orgId, metric: "pacientes_nuevos", fromMonth: firstDay(current), amount: Math.max(5, (lastNew ?? 0) + 5), currency: null, setBy: input.ownerUserId },
  ])
  // Lo que Ana y el Dr. Luis fijaron: las citas del agente por sede y quién tiene más inasistencias.
  await tx.insert(reportPin).values([
    { organizationId: orgId, figure: "agente_citas", groupBy: "sede", createdBy: input.ownerUserId },
    { organizationId: orgId, figure: "no_vinieron", groupBy: "profesional", createdBy: input.professionalUserId },
  ])
  return { pins: 2, goalText: formatMoney(goal, currency, locale) }
}
