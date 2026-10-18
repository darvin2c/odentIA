/**
 * Medición manual de Reportes (CLI, como la semilla): corre cada consulta de la
 * pantalla contra la base de desarrollo y dice cuánto tardó. La meta es menos
 * de 300 ms por consulta con la historia de una clínica mediana
 * (`seed-reports.ts`). No escribe nada.
 *
 *   pnpm --filter @odentia/services bench:reports
 */
import { createAppDb, type Db, withOrgContext } from "@odentia/db"
import { getReportList, getReportMoney, getReportSales, getReportService } from "./reports.js"
import { getReportProfessionals, getReportSummary } from "./report-summary.js"
import { getAgentReportList, getReportAgent } from "./report-agent.js"
import { getAgendaReport } from "./report-agenda.js"
import { getReportCommissions, getReportFinance, getReportOutlook, getReportPromotions } from "./report-finance.js"
import { getPatientReportList, getReportFunnel, getReportPatients } from "./report-patients.js"

const ORG = process.env.BENCH_ORG ?? "seed-org-dental-smile"
const url = process.env.APP_DATABASE_URL
if (!url) throw new Error("Falta APP_DATABASE_URL")
const db = createAppDb(url)

const PERIODS = ["este_mes", "mes_pasado", "ultimos_3_meses", "este_ano"]
type Read = (tx: Db, org: string, query: { period: string }) => Promise<unknown>
const READS: Record<string, Read> = {
  summary: getReportSummary,
  professionals: getReportProfessionals,
  money: getReportMoney,
  agenda: getAgendaReport,
  sales: getReportSales,
  service: getReportService,
  "list:new_patients": (tx, org, query) => getReportList(tx, org, { ...query, list: "new_patients" }),
  // Agente, con lo pagado a odentIA (lo más pesado: cada tramo de la suscripción entero).
  agent: (tx, org, query) => getReportAgent(tx, org, query, new Date(), { billing: true }),
  "list:agent_booked": (tx, org, query) => getAgentReportList(tx, org, { ...query, list: "agent_booked" }),
  "list:agent_handoffs": (tx, org, query) => getAgentReportList(tx, org, { ...query, list: "agent_handoffs" }),
  finance: getReportFinance,
  commissions: getReportCommissions,
  outlook: getReportOutlook,
  promotions: getReportPromotions,
  patients: getReportPatients,
  funnel: getReportFunnel,
  "list:funnel_lost_booked": (tx, org, query) => getPatientReportList(tx, org, { ...query, list: "funnel_lost_booked" }),
  "list:lapsed": (tx, org, query) => getPatientReportList(tx, org, { ...query, list: "lapsed" }),
}
// `BENCH_ONLY=agenda,money` mide solo esas consultas.
const only = process.env.BENCH_ONLY?.split(",").map((name) => name.trim()).filter(Boolean)

const rows: Array<{ consulta: string; periodo: string; ms: number }> = []
for (const period of PERIODS) {
  for (const [name, read] of Object.entries(READS)) {
    if (only && !only.includes(name)) continue
    // Una vuelta para calentar y tres medidas: se informa la mediana.
    await withOrgContext(db, ORG, (tx) => read(tx, ORG, { period }))
    const times: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now()
      await withOrgContext(db, ORG, (tx) => read(tx, ORG, { period }))
      times.push(performance.now() - start)
    }
    rows.push({ consulta: name, periodo: period, ms: Math.round(times.sort((a, b) => a - b)[1] ?? 0) })
  }
}
console.table(rows)
const slow = rows.filter((row) => row.ms > 300)
console.log(slow.length === 0 ? "Todas bajo 300 ms" : `${slow.length} pasan de 300 ms`)
process.exit(0)
