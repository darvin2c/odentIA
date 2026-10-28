import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patientPayment } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { reportDigestSend } from "@odentia/db/schema/reports"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { configurePublicLinks, setReportDigest } from "@odentia/services"
import { insertTestPatients } from "@odentia/services/test-patient"
import { beforeAll, expect, it } from "vitest"
import { runReportDigestTick } from "./report-digests.js"
import { appDb, KEY, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * SONDEO (no es regresión): el resumen del lunes cuando el correo falla un lunes.
 * Afirma lo que HOY pasa.
 */
setupTestDb()
const MONDAY = new Date("2026-10-12T15:00:00Z")

beforeAll(async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  await ownerDb.insert(user).values({ id: "s-ana", name: "Ana Torres", email: "ana@sondeo.test", emailVerified: true })
  await ownerDb.insert(member).values({ id: "m-s-ana", userId: "s-ana", organizationId: "org_a", role: "owner", createdAt: new Date() })
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: "Centro" }).returning()
  const [patient] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Rosa", patientNumber: 951 })
  await ownerDb.insert(patientPayment).values({ organizationId: "org_a", patientId: patient!.id, branchId: site!.id, amountCents: 50_000, currency: "PEN", paidAt: new Date("2026-10-07T15:00:00Z"), methodName: "Efectivo" })
  await withOrgContext(appDb, "org_a", (tx) => setReportDigest(tx, "org_a", "s-ana", true))
})

it("con el correo caído a las 8, el resumen de esa semana se pierde y nadie se entera", async () => {
  const sent: string[] = []
  const down = { async send() { throw new Error("SMTP: connection refused") } }
  const up = { async send(message: { to: string }) { sent.push(message.to) } }
  const first = await runReportDigestTick({ ownerDb, appDb, mailer: down, secretsKey: KEY, now: MONDAY })
  // El correo vuelve una hora después, el mismo lunes.
  const later = await runReportDigestTick({ ownerDb, appDb, mailer: up, secretsKey: KEY, now: new Date(MONDAY.getTime() + 3_600_000) })
  const rows = await ownerDb.select({ state: reportDigestSend.state, detail: reportDigestSend.detail }).from(reportDigestSend)
  const bell = await ownerDb.select().from(workspaceNotification)
  console.log("[sondeo 8b] primera vuelta:", first, "| vuelta con el correo ya sano:", later, "| enviados:", sent.length, "| fila:", rows, "| avisos en la campana:", bell.length)
  expect(first).toEqual({ mailed: 0, skipped: 0, uncertain: 1 })
  expect(later).toEqual({ mailed: 0, skipped: 0, uncertain: 0 })
  expect(sent).toEqual([])
  expect(rows[0]?.state).toBe("incierto")
  expect(bell).toEqual([])
})
