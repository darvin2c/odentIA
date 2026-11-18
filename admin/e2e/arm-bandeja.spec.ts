/**
 * La Bandeja con correos (ADR 0196), de punta a punta en pantalla: llegan dos
 * correos de fuera de la app, uno desde el correo de una persona que ya tenemos
 * como contacto, sin el remitente verificado, y otro de un proveedor. Con el
 * canal «Correo» puesto, la Bandeja los muestra sin los números de las vistas.
 * El del contacto se abre, «Puede ser de …» avisa que el remitente no está
 * verificado y «Es de …» lo liga (nada se liga solo); «Lo atiendo yo» queda a la vista, «Mejorar con Kairós» propone y
 * se usa, y lo escrito no se pierde al querer abrir otra conversación. La
 * respuesta sale con *negrita*, _cursiva_, ~tachado~ y lista, y en el correo
 * llega con su formato. El del proveedor «No necesita respuesta» y vuelve a
 * «Te toca». Soporte no abre el hilo (403). A 390 px nada se desborda de lado y
 * la barra del editor pone la negrita sobre lo elegido.
 *
 * Kairós es el doble sin modelo (`LLM_MODEL=fake`): acredita la pantalla y la
 * regla de no inventar, no la calidad de la redacción. El correo sale por el
 * Mailpit del entorno, no por un proveedor real.
 */
import { createHmac, randomUUID } from "node:crypto"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { saasClient, saasClientContact, saasInboundEmail } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import type { Page } from "@playwright/test"
import { eq } from "drizzle-orm"
import { ADMIN, enterAdmin, surface } from "../../e2e/admin"
import { API } from "../../e2e/env"
import { api, expect, test } from "../../e2e/fixtures"
import { latestMessageFor } from "../../e2e/mailpit"

/** Que la página no se recorra de lado: lo ancho va dentro de su propio desplazamiento. */
async function expectNoSideScroll(page: Page, what: string): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  expect(scroll, `${what}: ancho de la página ${scroll} > ${inner}`).toBeLessThanOrEqual(inner)
}

/** Un correo que llega como lo entrega el worker de correo: firmado, desde el origen de la API. */
async function postEmail(page: Page, email: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(email)
  const secret = process.env.INBOUND_EMAIL_SECRET ?? ""
  expect(secret, "el entorno trae INBOUND_EMAIL_SECRET").not.toBe("")
  const timestamp = Math.floor(Date.now() / 1000)
  // Node no resuelve los *.localhost del entorno en Windows: se envía desde el navegador, sin cookie.
  const sender = await page.context().newPage()
  await sender.goto(`${API}/health`)
  const received = await sender.evaluate(
    async ({ raw, headers }) => {
      const response = await fetch("/api/inbound/email", {
        method: "POST",
        credentials: "omit",
        headers,
        body: raw,
      })
      return { status: response.status, text: await response.text() }
    },
    {
      raw,
      headers: {
        "content-type": "application/json",
        "x-sallca-timestamp": String(timestamp),
        "x-sallca-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex")}`,
      },
    },
  )
  await sender.close()
  expect(received.status, received.text).toBe(201)
}

const CAPTURAS = process.env.E2E_CAPTURAS_DIR

test("Bandeja: un correo se liga, se atiende, se mejora y sale con su formato; otro no necesita respuesta y vuelve; Soporte sin el hilo", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(300_000)
  const { page, user } = owner
  const shot = async (p: Page, name: string) => {
    const path = testInfo.outputPath(`${name}.png`)
    await p.screenshot({ path, fullPage: true })
    if (CAPTURAS) {
      mkdirSync(CAPTURAS, { recursive: true })
      cpSync(path, join(CAPTURAS, `${name}.png`))
    }
  }
  await page.setViewportSize({ width: 1366, height: 900 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await enterAdmin(page, user.password)

  // --- Una venta con su contacto, y dos correos que llegan de fuera -------------------------
  const tag = randomUUID().slice(0, 6)
  const domain = process.env.E2E_BASE_DOMAIN ?? ""
  const clinicName = `Clínica Sonrisa Andina ${tag}`
  const doctora = `dra.lopez.${tag}@clinica-andina.test`
  const [client] = await fixtureDb
    .insert(saasClient)
    .values({ name: clinicName, product: "dental", ownerUserId: user.id })
    .returning({ id: saasClient.id })
  const clientId = client?.id ?? ""
  await fixtureDb.insert(saasClientContact).values({
    clientId,
    name: "Carmen López",
    email: doctora,
    roles: ["decide"],
    isPrimary: true,
  })
  const subject = `Consulta por el plan ${tag}`
  const question = `Buenas tardes, ¿cuánto cuesta el plan para dos sillones? ${tag}`
  await postEmail(page, {
    mailbox: "hola",
    product: "dental",
    messageId: `<plan-${tag}@clinica-andina.test>`,
    from: doctora,
    fromName: "Carmen López",
    to: `hola@${domain}`,
    subject,
    text: question,
    receivedAt: new Date().toISOString(),
    attachments: [],
    // Sin verificar el remitente, el correo exacto de un contacto no lo liga solo: lo sugiere.
    senderVerified: false,
  })
  const supplierSubject = `Catálogo de insumos ${tag}`
  await postEmail(page, {
    mailbox: "contacto",
    product: "dental",
    messageId: `<catalogo-${tag}@insumos.test>`,
    from: `ventas.${tag}@insumos.test`,
    fromName: "Insumos del Sur",
    to: `contacto@${domain}`,
    subject: supplierSubject,
    text: `Les compartimos nuestro catálogo de este mes ${tag}`,
    receivedAt: new Date().toISOString(),
    attachments: [],
    senderVerified: true,
  })
  const [inbound] = await fixtureDb
    .select({ id: saasInboundEmail.id })
    .from(saasInboundEmail)
    .where(eq(saasInboundEmail.messageId, `<plan-${tag}@clinica-andina.test>`))
  const emailId = inbound?.id ?? ""
  expect(emailId, "el correo de la doctora quedó guardado").not.toBe("")

  // --- La Bandeja con el canal «Correo»: los dos esperan, sin los números de las vistas ------
  await page.goto(`${ADMIN}/inbox`)
  await expect(page.getByRole("heading", { level: 1, name: "Bandeja" })).toBeVisible()
  await page.getByRole("combobox", { name: "Canal" }).click()
  await page.getByRole("option", { name: "Correo", exact: true }).click()
  await expect(page).toHaveURL(/[?&]canal=correo/)
  await expect(page.getByRole("tab", { name: "Te toca", exact: true })).toBeVisible()
  const list = page.getByRole("region", { name: "Conversaciones" })
  const planRow = list.getByRole("listitem").filter({ hasText: subject })
  const supplierRow = list.getByRole("listitem").filter({ hasText: supplierSubject })
  await expect(planRow).toContainText("Te toca")
  await expect(planRow).toContainText("Correo")
  await expect(planRow).toContainText("Sin cliente: elegir")
  await expect(supplierRow).toContainText("Sin cliente: elegir")
  await shot(page, "bandeja-correo-1366")

  // --- El hilo: «Es de …» lo liga, y la fase sale sola ---------------------------------------
  await planRow.getByRole("button").click()
  const pane = page.getByRole("region", { name: "Conversación abierta" })
  const thread = pane.getByRole("region", { name: subject })
  await expect(thread).toContainText(question)
  await expect(thread).toContainText(`Puede ser de ${clinicName}`)
  await expect(thread).toContainText("el remitente no está verificado")
  await expect(thread).toContainText("Nada se liga solo.")
  await thread.getByRole("button", { name: `Es de ${clinicName}` }).click()
  await expect(page.getByText("Listo: el correo y su hilo quedan en esa ficha")).toBeVisible()
  await expect(thread.getByRole("link", { name: `Ver la ficha de ${clinicName}` })).toBeVisible()
  await expect(thread).toContainText("· Por vender")
  await expect(planRow).toContainText(`${clinicName} · Por vender`)

  // --- «Lo atiendo yo»: queda dicho en el hilo y en la fila ---------------------------------
  await thread.getByRole("button", { name: "Lo atiendo yo" }).click()
  await expect(page.getByText("Lo atiendes tú", { exact: true })).toBeVisible()
  await expect(thread).toContainText("· Lo atiendes tú")
  await expect(thread.getByRole("button", { name: "Ya no lo atiendo" })).toBeVisible()
  const firstName = user.name.trim().split(/\s+/)[0] ?? ""
  await expect(planRow).toContainText(`· ${firstName}`)

  // --- «Mejorar con Kairós»: propone, se ve la diferencia y se usa --------------------------
  const reply = thread.getByRole("textbox", { name: "Respuesta", exact: true })
  await reply.fill("buen dia doctora,le paso  los precios")
  await thread.getByRole("button", { name: "Mejorar con Kairós" }).click()
  const proposal = thread.getByRole("region", { name: "Lo que propone Kairós" })
  await expect(proposal).toBeVisible()
  await shot(page, "bandeja-mejorar-1366")
  await proposal.getByRole("button", { name: "Usar esto" }).click()
  await expect(proposal).toHaveCount(0)
  await expect(reply).toHaveValue(/^Buen d[ií]a doctora, le paso los precios\.$/)

  // --- Lo escrito no se pierde al querer abrir otra conversación ----------------------------
  const formatted = [
    "Buen día, *doctora*. Le paso _los precios_ y quito el ~viejo~ plan:",
    "",
    "- Dos sillones",
    "- Kairós incluido",
  ].join("\n")
  await reply.fill(formatted)
  await supplierRow.getByRole("button").click()
  const unsaved = page.getByRole("alertdialog")
  await expect(unsaved).toContainText("Lo que escribiste en esta conversación se pierde.")
  await unsaved.getByRole("button", { name: "Seguir aquí" }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(reply).toHaveValue(formatted)
  await shot(page, "bandeja-respuesta-1366")

  // --- Sale, y en el correo llega con su formato --------------------------------------------
  await thread.getByRole("button", { name: "Enviar", exact: true }).click()
  await expect(page.getByText(`Respuesta enviada a ${doctora}`)).toBeVisible()
  const mail = await latestMessageFor(doctora, subject)
  expect(mail.html).toContain("<strong>doctora</strong>")
  expect(mail.html).toContain("<em>los precios</em>")
  expect(mail.html).toContain("<s>viejo</s>")
  expect(mail.html).toMatch(/<li[^>]*>Dos sillones<\/li>/)
  expect(mail.html).not.toContain("*doctora*")
  // Respondida: sale de «Te toca».
  await expect(planRow).toHaveCount(0)

  // --- El del proveedor: «No necesita respuesta» y «Volver a «Te toca»» ---------------------
  await supplierRow.getByRole("button").click()
  const supplier = pane.getByRole("region", { name: supplierSubject })
  await supplier.getByRole("button", { name: "No necesita respuesta" }).click()
  await expect(page.getByText("Listo: ya no espera respuesta")).toBeVisible()
  await expect(supplierRow).toHaveCount(0)
  await page.getByRole("tab", { name: "Todas", exact: true }).click()
  await expect(supplierRow).toContainText("Respondida")
  await supplier.getByRole("button", { name: "Volver a «Te toca»" }).click()
  await expect(page.getByText("Vuelve a esperar respuesta")).toBeVisible()
  await expect(supplierRow).toContainText("Te toca")

  // --- Soporte: el hilo no existe para él (403) ----------------------------------------------
  const support = await createOwner("soporte")
  await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
  await enterAdmin(support.page, support.user.password)
  const denied = await api(support.page, "GET", `/api/admin/inbox/correo/${emailId}`, undefined)
  expect(denied.status).toBe(403)

  // --- A 390 px: la lista, el hilo y la barra del editor -------------------------------------
  await page.bringToFront()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${ADMIN}/inbox?canal=correo`)
  await expect(supplierRow).toBeVisible()
  await expectNoSideScroll(page, "Bandeja")
  await shot(page, "bandeja-correo-390")
  await supplierRow.getByRole("button").click()
  await expect(list).toBeHidden()
  // Los botones de «¿De quién es?» bajan de línea si no caben: ninguno queda cortado.
  const create = pane.getByRole("button", { name: "Crear cliente con este correo" })
  await create.scrollIntoViewIfNeeded()
  await expect(create).toBeInViewport({ ratio: 1 })
  const small = pane.getByRole("textbox", { name: "Respuesta", exact: true })
  await small.fill("Gracias, equipo")
  // «Negrita» sobre lo elegido: pone las marcas a los lados, sin tocar lo demás.
  await small.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(9, 15))
  await pane.getByRole("button", { name: "Negrita" }).click()
  await expect(small).toHaveValue("Gracias, *equipo*")
  await expectNoSideScroll(page, "Hilo en la Bandeja")
  await shot(page, "bandeja-hilo-390")
  await expect(surface(page, supplierSubject)).toBeVisible()
})
