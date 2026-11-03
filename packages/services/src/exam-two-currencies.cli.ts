/**
 * Crea en la base de desarrollo la clínica de examen con dólares, para comparar Argos
 * con Reportes sobre ella:
 *
 *   pnpm --filter @odentia/services seed:examen-dolares
 *   pnpm --filter @odentia/agent eval:argos-cifras -- --org=examen-dolares
 */
import { createAppDb, createOwnerDb } from "@odentia/db"
import { buildTwoCurrencyExam } from "./exam-two-currencies.js"

const owner = process.env.DATABASE_URL
const app = process.env.APP_DATABASE_URL
if (!owner || !app) throw new Error("Faltan DATABASE_URL y APP_DATABASE_URL (el .env de infra/dev)")
const orgId = process.argv.find((item) => item.startsWith("--org="))?.slice(6) ?? "examen-dolares"
await buildTwoCurrencyExam(createOwnerDb(owner), createAppDb(app), orgId)
console.log(
  `Lista la clínica de examen ${orgId}. Corre: pnpm --filter @odentia/agent eval:argos-cifras -- --org=${orgId}`,
)
process.exit(0)
