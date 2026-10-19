import { withOrgContext } from "@odentia/db"
import { supportCase, supportNotice } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { configurePublicLinks, replyToSupportCase, sendHelpRequest, SUPPORT_REPLY_NOTICE_DELAY_MS } from "@odentia/services"
import { eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { runSupportNoticesTick } from "./support-notices.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const urls = { adminUrl: "https://admin.odentia.test", webUrl: "https://app.odentia.test" }

beforeAll(async () => {
  configurePublicLinks({ webURL: urls.webUrl, cookieDomain: "odentia.test" })
  await ownerDb.insert(user).values([
    { id: "w-ana", name: "Ana Torres", email: "ana@worker.test", emailVerified: true },
    { id: "w-staff", name: "Soporte", email: "staff@worker.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values({ id: "m-w-ana", userId: "w-ana", organizationId: "org_a", role: "owner", createdAt: new Date() })
})

const statesOf = async (caseId: string) =>
  (await ownerDb.select().from(supportNotice).where(eq(supportNotice.caseId, caseId))).map((row) => [row.kind, row.emailState])

it("reclama antes de SMTP, no lleva el texto del caso y no reintenta un envío incierto", async () => {
  const question = "No puedo cambiar la hora del recordatorio"
  const kase = await withOrgContext(appDb, "org_a", (tx) =>
    sendHelpRequest(tx, "org_a", { userId: "w-ana", roleLabel: "Propietario" }, { question, screen: "/agent/administrador" }),
  )
  const sent: Array<{ to: string; subject: string; html: string; text: string; state: string | undefined }> = []
  let failNext = true
  const mailer = {
    async send(message: { to: string; subject: string; html: string; text: string }) {
      // Al llamar a SMTP el aviso ya está reclamado.
      const rows = await ownerDb.select({ state: supportNotice.emailState }).from(supportNotice).where(eq(supportNotice.caseId, kase.id))
      sent.push({ ...message, state: rows.some((row) => row.state === "reclamado") ? "reclamado" : undefined })
      if (failNext) {
        failNext = false
        throw new Error("SMTP no respondió")
      }
    },
  }

  // Sin buzón configurado, el aviso a soporte espera.
  const waiting = await runSupportNoticesTick({ ownerDb, mailer, supportInbox: "", ...urls })
  expect(waiting.pending).toBeGreaterThanOrEqual(1)
  expect(await statesOf(kase.id)).toEqual([["caso_nuevo", "pendiente"]])

  // Falla la entrega: queda incierto y la vuelta siguiente no lo repite.
  await runSupportNoticesTick({ ownerDb, mailer, supportInbox: "soporte@odentia.test", ...urls })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ to: "soporte@odentia.test", subject: "Caso nuevo · Clínica · Pregunta", state: "reclamado" })
  expect(sent[0]!.text).toContain("Quién: Ana Torres (propietario)")
  expect(sent[0]!.text).toContain("Pantalla: Agente › Administrador")
  expect(sent[0]!.html).toContain(`https://admin.odentia.test/support?caso=${kase.id}`)
  expect(sent[0]!.text).not.toContain(question)
  expect(await statesOf(kase.id)).toEqual([["caso_nuevo", "incierto"]])
  await runSupportNoticesTick({ ownerDb, mailer, supportInbox: "soporte@odentia.test", ...urls })
  expect(sent).toHaveLength(1)

  // Soporte responde y Ana no lo ve: el correo la lleva a Ayuda, sin la respuesta.
  const answer = "Se cambia en la línea «Recordar la cita»."
  await replyToSupportCase(ownerDb, { userId: "w-staff", role: "support" }, kase.id, answer)
  const [row] = await ownerDb.select({ at: supportCase.lastPublicMessageAt }).from(supportCase).where(eq(supportCase.id, kase.id))
  const now = new Date(row!.at!.getTime() + SUPPORT_REPLY_NOTICE_DELAY_MS + 60_000)
  await runSupportNoticesTick({ ownerDb, mailer, supportInbox: "soporte@odentia.test", ...urls, now })
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({ to: "ana@worker.test", subject: "Soporte de odentIA respondió tu caso", state: "reclamado" })
  expect(sent[1]!.text).toContain("Tienes una respuesta sobre «Pregunta · Administrador». Responde desde odentIA")
  expect(sent[1]!.text).toContain("Este correo no recibe respuestas")
  expect(sent[1]!.html).toContain(`https://norte.odentia.test/home?ayuda=casos&amp;caso=${kase.id}`)
  expect(sent[1]!.text).not.toContain(answer)
  expect((await statesOf(kase.id)).sort()).toEqual([["caso_nuevo", "incierto"], ["respuesta", "enviado"]])
})
