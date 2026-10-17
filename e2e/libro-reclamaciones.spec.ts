import { randomUUID } from "node:crypto"
import { adminAudit, adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { consumerComplaint } from "@odentia/db/schema/consumer-complaints"
import { and, desc, eq } from "drizzle-orm"
import { hostUrl } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/** Último correo a `email` con ese asunto, en el Mailpit del recorrido. */
async function mailTo(email: string, subject: string): Promise<{ HTML: string; Text: string }> {
  const base = process.env.MAILPIT_API
  if (!base) throw new Error("Ejecuta pnpm e2e para crear un entorno aislado")
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const search = await fetch(`${base}/search?${new URLSearchParams({ query: `to:${email}`, limit: "20" })}`)
    const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] }
    const match = messages.find((m) => m.Subject.includes(subject))
    if (match) return (await (await fetch(`${base}/message/${match.ID}`)).json()) as { HTML: string; Text: string }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`No llegó el correo «${subject}» a ${email}`)
}

/**
 * Libro de Reclamaciones en la administración: la lista con su plazo, la hoja
 * en el panel lateral, la respuesta con su confirmación, el correo que recibe
 * quien reclamó, el reenvío cuando el correo no salió, Inicio y el teléfono.
 * Las hojas se preparan por la base: guardarlas ya lo prueba la ruta pública.
 */
test("libro de reclamaciones: el personal lista, abre, responde y reenvía", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page, user } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const day = 86_400_000
  const now = Date.now()
  const tag = randomUUID().slice(0, 6)

  // La persona del recorrido es personal de odentIA con su segundo factor verificado en esta sesión.
  const [current] = await fixtureDb.select({ id: session.id }).from(session).where(eq(session.userId, user.id)).orderBy(desc(session.createdAt)).limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await fixtureDb.insert(twoFactor).values({ id: factorId, userId: user.id, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({ userId: user.id, sessionId: current!.id, factorId, method: "totp", expiresAt: new Date(now + day) })

  let seq = Math.floor(Math.random() * 800_000) + 100_000
  const sheet = (name: string, email: string, daysAgo: number, extra: Partial<typeof consumerComplaint.$inferInsert> = {}) => ({
    number: `2026-${seq++}`,
    year: 2026,
    submissionId: randomUUID(),
    kind: "reclamo",
    consumerName: name,
    consumerAddress: "Av. Los Álamos 412, Surco, Lima",
    documentType: "DNI",
    documentNumber: "45871236",
    phone: "+51 987 654 321",
    email,
    itemType: "servicio",
    itemDescription: "Suscripción mensual de odentIA para mi clínica",
    amountMinor: 29000,
    amountCurrency: "PEN",
    detail: "Me cobraron dos veces la suscripción de octubre, el 1 y el 3.",
    request: "Que me devuelvan el segundo cobro.",
    privacyAcceptedAt: new Date(now - daysAgo * day),
    emailSent: true,
    createdAt: new Date(now - daysAgo * day),
    ...extra,
  })
  const lucia = `lucia-${tag}@ejemplo.test`
  const jorge = `jorge-${tag}@ejemplo.test`
  const [fresh] = await fixtureDb
    .insert(consumerComplaint)
    .values([
      sheet(`Rosa Huamán ${tag}`, `rosa-${tag}@ejemplo.test`, 40),
      sheet(`Lucía Ramos ${tag}`, lucia, 0),
      sheet(`Jorge Mendoza ${tag}`, jorge, 10, {
        kind: "queja",
        status: "respondido",
        providerResponse: "Revisamos tu caso y ajustamos los turnos de soporte.",
        respondedAt: new Date(now - day),
        respondedByUserId: user.id,
        responseEmailSent: false,
      }),
    ])
    .returning()
    .then((rows) => rows.filter((row) => row.email === lucia))

  // Lista: lo pendiente primero, con su plazo; la vencida dice que venció.
  await gotoHydrated(page, hostUrl("admin", "/complaints"))
  await expect(page.getByRole("heading", { name: "Libro de Reclamaciones", level: 1 })).toBeVisible()
  const rosaRow = page.getByRole("row").filter({ hasText: `Rosa Huamán ${tag}` })
  await expect(rosaRow.getByText("Venció", { exact: false })).toBeVisible()
  const luciaRow = page.getByRole("row").filter({ hasText: `Lucía Ramos ${tag}` })
  await expect(luciaRow.getByText(/Quedan 1[45] días hábiles/)).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: `Jorge Mendoza ${tag}` })).toHaveCount(0)
  await expect(page.getByRole("link", { name: /Libro de Reclamaciones/ })).toBeVisible()
  await shot("lista")

  // La hoja se abre al lado y se responde con confirmación.
  await luciaRow.click()
  const panel = page.getByRole("region", { name: `Hoja N.º ${fresh!.number}` })
  await expect(panel).toBeVisible()
  await expect(panel.getByText("DNI 45871236")).toBeVisible()
  await expect(panel.getByText("S/ 290.00")).toBeVisible()
  const answer = `Hola, Lucía. Revisamos tu cuenta y tienes razón: hubo un segundo cobro de S/ 290.00. Ya pedimos la devolución <b>${tag}</b>.`
  await panel.getByLabel("Qué hicimos y qué le respondemos").fill(answer)
  await expect(panel.getByText("Borrador guardado en este equipo")).toBeVisible()
  await shot("hoja-abierta")
  await panel.getByRole("button", { name: "Enviar respuesta…" }).click()
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "¿Enviar la respuesta" })
  await expect(dialog).toBeVisible()
  await shot("confirmar")
  await dialog.getByRole("button", { name: "Enviar respuesta" }).click()
  await expect(dialog).toBeHidden()
  await expect(panel.getByText("Respondida", { exact: true })).toBeVisible()
  await expect(panel.getByText(`Enviado a ${lucia}`)).toBeVisible()
  await expect(panel.getByLabel("Qué hicimos y qué le respondemos")).toHaveCount(0)
  await shot("respondida")

  // El correo que recibe Lucía: la respuesta escapada arriba y su hoja con el bloque 4.
  const mail = await mailTo(lucia, `Respuesta a tu Hoja de Reclamación N.º ${fresh!.number}`)
  expect(mail.HTML).toContain(`&lt;b&gt;${tag}&lt;/b&gt;`)
  expect(mail.Text).toContain("NUESTRA RESPUESTA")
  expect(mail.Text).toContain("4. OBSERVACIONES Y ACCIONES ADOPTADAS POR EL PROVEEDOR")

  const [row] = await fixtureDb.select().from(consumerComplaint).where(eq(consumerComplaint.id, fresh!.id))
  expect(row?.status).toBe("respondido")
  expect(row?.respondedByUserId).toBe(user.id)
  expect(row?.responseEmailSent).toBe(true)
  const audits = await fixtureDb.select().from(adminAudit).where(and(eq(adminAudit.entityId, fresh!.id), eq(adminAudit.actorUserId, user.id)))
  expect(audits.map((a) => a.action).sort()).toEqual(["consumer_complaint.respond", "consumer_complaint.view"])

  // Respondidas: la de Jorge tiene el correo sin enviar y se reenvía a mano.
  await gotoHydrated(page, hostUrl("admin", "/complaints?estado=respondido"))
  const jorgeRow = page.getByRole("row").filter({ hasText: `Jorge Mendoza ${tag}` })
  await expect(jorgeRow.getByText("Correo sin enviar")).toBeVisible()
  await jorgeRow.click()
  const notice = page.getByText("La respuesta quedó guardada, pero el correo a Jorge no salió", { exact: false })
  await notice.scrollIntoViewIfNeeded()
  await expect(notice).toBeVisible()
  await shot("correo-sin-enviar")
  await page.getByRole("button", { name: "Reenviar el correo" }).click()
  await expect(page.getByText(`Enviado a ${jorge}`)).toBeVisible()
  await shot("correo-reenviado")
  await mailTo(jorge, "Respuesta a tu Hoja de Reclamación")

  // Inicio lo trae como pendiente.
  await gotoHydrated(page, hostUrl("admin", "/"))
  await expect(page.getByRole("link", { name: /Libro de Reclamaciones por responder/ })).toBeVisible()
  await shot("inicio")

  // En el teléfono: la lista en filas y la hoja en cajón.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, hostUrl("admin", "/complaints"))
  await expect(page.getByText(`Rosa Huamán ${tag}`)).toBeVisible()
  await shot("telefono-lista")
  await page.getByText(`Rosa Huamán ${tag}`).click()
  await expect(page.getByRole("dialog").getByLabel("Qué hicimos y qué le respondemos")).toBeVisible()
  await shot("telefono-hoja")
})
