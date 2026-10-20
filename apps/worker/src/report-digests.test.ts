import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patientPayment } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { reportDigestSend } from "@odentia/db/schema/reports"
import { configurePublicLinks, setReportDigest } from "@odentia/services"
import { insertTestPatients } from "@odentia/services/test-patient"
import { eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { runReportDigestTick } from "./report-digests.js"
import { appDb, KEY, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Lunes 12 de octubre de 2026, 10:00 en Lima: le toca el de la semana del 5 al 11. */
const MONDAY = new Date("2026-10-12T15:00:00Z")

beforeAll(async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  await ownerDb.insert(user).values([
    { id: "d-ana", name: "Ana Torres", email: "ana@digest.test", emailVerified: true },
    { id: "d-caja", name: "Caja", email: "caja@digest.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: "m-d-ana", userId: "d-ana", organizationId: "org_a", role: "owner", createdAt: new Date() },
    { id: "m-d-caja", userId: "d-caja", organizationId: "org_a", role: "cashier", createdAt: new Date() },
  ])
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: "Centro" }).returning()
  // Un cobro en la semana: el resumen tiene algo que decir.
  const [patient] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Rosa", patientNumber: 901 })
  await ownerDb.insert(patientPayment).values({ organizationId: "org_a", patientId: patient!.id, branchId: site!.id, amountCents: 50_000, currency: "PEN", paidAt: new Date("2026-10-07T15:00:00Z"), methodName: "Efectivo" })
  await withOrgContext(appDb, "org_a", async (tx) => {
    await setReportDigest(tx, "org_a", "d-ana", true)
    // Caja lo había prendido cuando veía Reportes: ya no lo recibe.
    await setReportDigest(tx, "org_a", "d-caja", true)
  })
})

it("reserva la semana antes de enviar, no lo repite y no le escribe a quien ya no ve Reportes", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const mailer = {
    async send(message: { to: string; subject: string; html: string; text: string }) {
      // Al llamar a SMTP la semana ya está reservada.
      const rows = await ownerDb.select({ state: reportDigestSend.state }).from(reportDigestSend).where(eq(reportDigestSend.userId, "d-ana"))
      expect(rows.map((row) => row.state)).toEqual(["reclamado"])
      sent.push(message)
    },
  }
  const first = await runReportDigestTick({ ownerDb, appDb, mailer, secretsKey: KEY, now: MONDAY })
  const states = await ownerDb.select({ userId: reportDigestSend.userId, state: reportDigestSend.state, detail: reportDigestSend.detail }).from(reportDigestSend)
  expect(states).toContainEqual({ userId: "d-caja", state: "omitido", detail: "sin_permiso" })
  expect(states).toContainEqual({ userId: "d-ana", state: "enviado", detail: null })
  expect(first).toEqual({ mailed: 1, skipped: 1, uncertain: 0 })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ to: "ana@digest.test" })
  expect(sent[0]?.subject).toMatch(/^Tu semana: S\/\s?500\.00 cobrados/)
  expect(sent[0]?.text).toContain("Dejar de recibirlo: https://norte.odentia.test/resumen-lunes/baja/")

  // La vuelta siguiente del mismo lunes no repite a nadie.
  const again = await runReportDigestTick({ ownerDb, appDb, mailer, secretsKey: KEY, now: new Date(MONDAY.getTime() + 60_000) })
  expect(again).toEqual({ mailed: 0, skipped: 0, uncertain: 0 })
})
