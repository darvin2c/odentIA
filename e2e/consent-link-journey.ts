import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import type { Db } from "@odentia/db"
import { channelTemplate, conversation as conversationTable, message as messageTable } from "@odentia/db/schema/crm"
import type { Browser, Page, TestInfo } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { expect } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * El consentimiento por enlace, de punta a punta y en cada producto: el equipo
 * lo envía, la persona firma sin sesión, Sofi lo agradece por su conversación y
 * la clínica ve su firma antes de confirmarlo. WhatsApp es controlado: esto no
 * acredita que un mensaje llegue a un teléfono de verdad ni que Meta apruebe uno.
 *
 * Con `wroteLongAgo` escribió hace dos días, que es lo normal: el enlace y el
 * agradecimiento salen como mensajes aprobados, porque tocar el botón del enlace
 * no abre las 24 horas.
 */
export async function consentLinkJourney(input: {
  page: Page
  browser: Browser
  info: TestInfo
  slug: string
  apiBase: string
  userId: string
  url: (path: string) => string
  orgId: string
  /** La plantilla sugerida de ese producto. */
  templateKey: string
  /** Cómo se dice «quien atiende» en ese producto. */
  clinician: string
  nextEventId: () => number
  wroteLongAgo?: { db: Db }
}) {
  const { page, browser, info, slug, apiBase, userId, url, templateKey, clinician, nextEventId, wroteLongAgo } = input
  const call = async <T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
    const result = await page.evaluate(
      async (request) => {
        const response = await fetch(`${request.apiBase}${request.path}`, {
          method: request.method,
          headers: { "content-type": "application/json", "x-odentia-org": request.slug },
          credentials: "include",
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        })
        return { status: response.status, body: (await response.json()) as { data: unknown } }
      },
      { apiBase, slug, method, path, body },
    )
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected)
    return result.body.data as T
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  // Escribió hace un momento por WhatsApp y es paciente: se le puede responder.
  const appSecret = "e2e-secret"
  const connection = await call<{ id: string }>("POST", "/api/channels/connections", {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID", wabaId: "E2E-WABA", accessToken: "e2e", appSecret, templates: [] },
  }, 201)
  const inbound = await simulateWhatsAppInbound(page, apiBase, connection.id, appSecret, {
    from: `519${String(nextEventId()).padStart(8, "0").slice(-8)}`,
    name: "Eva Rojas",
    phoneNumberId: "E2E-PNID",
    text: "Hola",
    wamid: `wamid.${nextEventId()}`,
  })
  expect(inbound).toBe(200)
  type Thread = { id: string; contact: { id: string }; connection: { id: string } }
  const thread = async () =>
    (await call<Thread[]>("GET", "/api/conversations")).find((row) => row.connection.id === connection.id)
  await expect.poll(async () => (await thread())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const conversation = (await thread())!
  const patient = await call<{ id: string }>("POST", "/api/patients", {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Eva Rojas", givenNames: "Eva", familyName: "Rojas", birthDate: "1990-05-20", docType: "DNI", docNumber: "45678902" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  await call("PUT", `/api/patients/${patient.id}/contacts/${conversation.contact.id}`, { relationship: "self", isPreferred: true })
  await call("PUT", "/api/agent/config", { enabled: true })
  const templates = await call<{ id: string; key: string; title: string; status: string }[]>("GET", "/api/clinical-forms/consent-templates")
  const template = templates.find((row) => row.key === templateKey && row.status === "publicado")
  if (!template) throw new Error(`Falta la plantilla ${templateKey}`)
  const consent = await call<{ id: string }>("POST", "/api/clinical-forms/consents", {
    templateId: template.id,
    patientId: patient.id,
    procedureRef: "Procedimiento de prueba",
  }, 201)

  if (wroteLongAgo) {
    await wroteLongAgo.db
      .update(conversationTable)
      .set({ lastInboundAt: new Date(Date.now() - 48 * 3_600_000) })
      .where(eq(conversationTable.id, conversation.id))
    // Lo que WhatsApp ya aprobó en esta cuenta: «Su enlace» y «Recibido desde su enlace».
    for (const [name, body] of [
      ["odentia_su_enlace_v1", "Hola, {{1}}. En {{2}} te dejamos aquí lo que tienes pendiente con nosotros."],
      ["odentia_enlace_recibido_v1", "Hola, {{1}}. {{2}} ya recibió lo que completaste desde tu enlace. Gracias por tu tiempo."],
    ] as const) {
      await wroteLongAgo.db
        .insert(channelTemplate)
        .values({ organizationId: input.orgId, connectionId: connection.id, name, language: "es", status: "aprobada", category: "utility", body, variables: 2 })
        .onConflictDoUpdate({
          target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
          set: { status: "aprobada", category: "utility", body, variables: 2 },
        })
    }
  }

  // El equipo lo envía desde el papel.
  const documents = url(`/patients/${patient.id}?tab=documentos`)
  const paper = `Consentimiento · ${template.title}`
  const row = () => page.getByRole("listitem").filter({ hasText: template.title })
  await gotoHydrated(page, documents)
  await expect(row().getByText("Pendiente", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: new RegExp(paper) }).first().click()
  const panel = surface(page, { name: paper })
  await expect(panel.getByText("Esta hoja es para firmar en papel", { exact: false })).toBeVisible()
  await panel.getByRole("button", { name: "Enviar para firmar" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Enviar", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toBeHidden()
  await gotoHydrated(page, documents)
  await expect(row().getByText("Se le envió para firmar", { exact: false })).toBeVisible()

  // Firma desde su teléfono, sin sesión, con el mismo enlace que se le envió.
  const shown = await call<{ url: string }>("POST", `/api/patients/${patient.id}/personal-link/show`, {}, 201)
  const token = new URL(shown.url).searchParams.get("token")
  const visitor = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  const phone = await visitor.newPage()
  await gotoHydrated(phone, url(`/reserva?token=${token}`))
  await phone.getByRole("button", { name: "Leer y firmar" }).click()
  await phone.getByLabel(/^Escribe tu DNI/).fill("45678902")
  await phone.getByRole("checkbox", { name: "Entendí lo que me explicaron" }).click()
  const pad = phone.getByRole("img", { name: "Tu firma" })
  await pad.scrollIntoViewIfNeeded()
  const box = (await pad.boundingBox())!
  await phone.mouse.move(box.x + 20, box.y + 30)
  await phone.mouse.down()
  await phone.mouse.move(box.x + 90, box.y + 70, { steps: 6 })
  await phone.mouse.move(box.x + 170, box.y + 25, { steps: 6 })
  await phone.mouse.up()
  await phone.getByRole("button", { name: "Firmar", exact: true }).click()
  await expect(phone.getByText("Firmado, gracias")).toBeVisible()
  await phone.screenshot({ path: info.outputPath("1-firmado-telefono.png") })
  await visitor.close()

  // Sofi lo agradece en su conversación, con las palabras de su producto y sin nombrar el procedimiento.
  const thanks = async () =>
    (await call<{ senderKind: string; body: string | null }[]>("GET", `/api/conversations/${conversation.id}/messages`))
      .filter((message) => message.senderKind === "agent")
      .map((message) => message.body ?? "")
      .find((body) => body.startsWith("Gracias por firmar")) ?? ""
  if (wroteLongAgo) {
    // Sigue sin escribir: el texto no saldría y lo que sale es el mensaje aprobado.
    const approved = async () =>
      wroteLongAgo.db
        .select({ contentType: messageTable.contentType, templateName: messageTable.templateName, body: messageTable.body })
        .from(messageTable)
        .where(and(eq(messageTable.conversationId, conversation.id), eq(messageTable.senderKind, "agent")))
    await expect.poll(async () => (await approved()).length, { timeout: 15_000 }).toBe(1)
    const [sent] = await approved()
    expect(sent).toMatchObject({ contentType: "template", templateName: "odentia_enlace_recibido_v1" })
    expect(sent?.body).toMatch(/^Hola, Eva\. .+ ya recibió lo que completaste desde tu enlace\. Gracias por tu tiempo\.$/)
  } else {
    await expect.poll(thanks, { timeout: 15_000 }).toBe(`Gracias por firmar el consentimiento. El ${clinician} lo revisará antes de empezar.`)
  }

  // La fila ya no pide la firma.
  await gotoHydrated(page, documents)
  await expect(row().getByText("Falta confirmar", { exact: true })).toBeVisible()
  await expect(row().getByText("Lo firmó desde su enlace", { exact: false })).toBeVisible()
  await expect(row().getByText("Pendiente", { exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("2-fila-falta-confirmar.png"), fullPage: true })

  // Al abrirla: el PDF de lo que firmó, y por qué aún no se envía.
  await page.getByRole("button", { name: new RegExp(paper) }).first().click()
  await expect(panel.getByText(/^Falta confirmar · /)).toBeVisible()
  await expect(panel.getByText("Se envía cuando lo confirmes.")).toBeVisible()
  await expect(panel.getByText("Esta hoja es para firmar en papel", { exact: false })).toHaveCount(0)
  await expect(panel.getByTitle(paper)).toHaveAttribute("src", /^blob:/)
  await page.screenshot({ path: info.outputPath("3-panel.png") })
  // El navegador de la prueba no dibuja el PDF: queda guardado para mirarlo.
  const pdf = await page.evaluate(
    async (request) => {
      const response = await fetch(`${request.apiBase}/api/patients/${request.patientId}/health-document-pdf?documentType=consent&documentId=${request.consentId}`, {
        headers: { "x-odentia-org": request.slug },
        credentials: "include",
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes: Array.from(bytes) }
    },
    { apiBase, slug, patientId: patient.id, consentId: consent.id },
  )
  expect(pdf.status).toBe(200)
  await writeFile(info.outputPath("falta-confirmar.pdf"), Buffer.from(pdf.bytes))

  // La historia dice lo que pasó.
  await panel.getByRole("button", { name: `Más acciones de ${paper}` }).click()
  await page.getByRole("menuitem", { name: "Historia del documento" }).click()
  const history = surface(page, { name: "Historia del documento" })
  await expect(history.getByText("Enviado para firmar desde su teléfono", { exact: false })).toBeVisible()
  await expect(history.getByText("Firmó desde su enlace", { exact: false })).toBeVisible()
  await page.screenshot({ path: info.outputPath("4-historia.png") })
  await history.getByRole("button", { name: "Cerrar" }).click()

  // Quien atiende lo confirma con su perfil: ahí queda firmado y ya se puede enviar.
  await call("PUT", `/api/clinical-forms/professionals/${userId}/profile`, {
    professionalTitle: "Profesional",
    registrationBody: "COL",
    registrationNumber: "12345",
  })
  await panel.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(panel.getByText(/^Firmado · /)).toBeVisible()
  await expect(panel.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath("5-confirmado.png") })
}
