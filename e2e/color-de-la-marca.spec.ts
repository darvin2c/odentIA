import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { latestHtmlFor } from "./mailpit"

/**
 * El color de la marca (ADR 0162): quien configura lo elige en Datos de la clínica, se
 * guarda aparte con «Usar este color», y la app y sus páginas públicas lo muestran desde
 * el primer pintado. Un color claro conserva el relleno exacto con letra oscura.
 */

/** El HTML que entrega el servidor, pedido desde la misma página (mismo sitio y sesión). */
const serverHtml = (page: Page, url: string) =>
  page.evaluate((target) => fetch(target, { credentials: "include", cache: "no-store" }).then((r) => r.text()), url)

/** Los colores de los enlaces se animan: la captura espera a que terminen. */
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))

/** El valor del token en la raíz, ya resuelto. */
const token = (page: Page, name: string) =>
  page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name)

test("elegir el color de la marca: vista previa, guardar, primer pintado, color claro y volver al de fábrica", async ({ browser, createOwner }, testInfo) => {
  const { page, org } = await createOwner("marca")
  await call(page, "PUT", "/api/org-profile", org.slug, {
    legalName: org.name,
    tradeName: "Sonrisa Azul",
    countryCode: "PE",
    currency: "PEN",
    timezone: "America/Lima",
    locale: "es-PE",
  })
  await gotoHydrated(page, tenant(org.slug, "/settings"))
  const block = page.getByRole("region", { name: "Color de la marca" })
  await expect(block).toBeVisible()
  // Viene con el turquesa de odentIA, elegido y sin nada por guardar.
  await expect(block.getByRole("button", { name: "Turquesa, el de odentIA" })).toHaveAttribute("aria-pressed", "true")
  await expect(block.getByRole("button", { name: "Usar este color" })).toHaveCount(0)
  expect(await token(page, "--primary-fill")).toBe("#0e7490")

  // Elegir solo cambia la vista previa: la app sigue en turquesa hasta guardar.
  await block.getByRole("button", { name: "Azul", exact: true }).click()
  await expect(block.getByText("Aún no se guarda")).toBeVisible()
  expect(await token(page, "--primary-fill")).toBe("#0e7490")
  await testInfo.attach("eleccion-escritorio", { body: await block.screenshot(), contentType: "image/png" })
  await block.getByRole("button", { name: "Usar este color" }).click()
  await expect(page.getByText("Color guardado. Tus pacientes ya lo ven.")).toBeVisible()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#2563eb")
  await expect(block.getByRole("button", { name: "Volver al turquesa de odentIA" })).toBeVisible()

  // Desde el primer pintado: el HTML del servidor ya trae el color, también en una página pública.
  const settingsHtml = await serverHtml(page, tenant(org.slug, "/settings"))
  expect(settingsHtml).toContain("--primary-fill:#2563eb")
  const publicHtml = await serverHtml(page, tenant(org.slug, "/embed"))
  expect(publicHtml).toContain("--primary-fill:#2563eb")

  // Lo que ve el paciente: el registro en su celular, sin sesión, ya en el azul de la clínica.
  const registration = await call<{ version: number; fields: unknown }>(page, "GET", "/api/patient-registration/config", org.slug)
  await call(page, "PUT", "/api/patient-registration/config", org.slug, {
    enabled: true,
    fields: registration.fields,
    privacyNotice: "Usamos tus datos solo para tu atención en la clínica.",
    expectedVersion: registration.version,
  })
  const visitor = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  try {
    const patient = await visitor.newPage()
    await gotoHydrated(patient, tenant(org.slug, "/registro?via=qr"))
    await expect(patient.getByText("Registro de paciente", { exact: true })).toBeVisible()
    expect(await token(patient, "--primary-fill")).toBe("#2563eb")
    await testInfo.attach("registro-celular", { body: await patient.screenshot(), contentType: "image/png" })
  } finally {
    await visitor.close()
  }
  // El chat web ya no tiene color propio: dice de dónde sale y su vista previa va en el azul.
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/webchat"))
  await page.getByRole("button", { name: /Opciones avanzadas/ }).click()
  await expect(page.getByText("Usa el color de tu marca")).toBeVisible()
  await expect(page.getByText("Color del chat")).toHaveCount(0)
  // La vista previa del chat es la ventana real, en modo prueba: su cabecera va en el azul de la clínica.
  const preview = page.frameLocator("iframe")
  await expect(preview.getByText("Sonrisa Azul").first()).toBeVisible()
  expect(await preview.locator("header").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(37, 99, 235)")
  await testInfo.attach("chat-web", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await gotoHydrated(page, tenant(org.slug, "/settings"))

  // Un naranja fuerte lleva letra blanca: el botón se tuesta apenas en vez de cambiar a letra oscura.
  await block.getByRole("button", { name: "Naranja", exact: true }).click()
  const atender = block.getByText("Atender", { exact: true })
  expect(await atender.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)")
  expect(await atender.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(204, 77, 10)")
  await testInfo.attach("naranja", { body: await block.screenshot(), contentType: "image/png" })

  // Un celeste claro: el botón lo conserva exacto con letra oscura y el texto usa un tono legible.
  await block.getByRole("button", { name: "Elegir otro color" }).click()
  const code = block.getByLabel("Código, si lo tienes")
  await code.fill("#7CC4EC")
  await expect(block.getByText(/Tu color es claro/)).toBeVisible()
  await block.getByRole("button", { name: "Usar este color" }).click()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#7cc4ec")
  expect(await token(page, "--primary-fill-foreground")).toBe("#181818")
  expect(await token(page, "--primary")).not.toBe("#7cc4ec")

  // Un código mal escrito se dice junto al campo al salir de él, y el color guardado no cambia.
  await code.fill("#7CC4E")
  await code.blur()
  await expect(block.getByText("Le falta 1 cifra: el código tiene 6, como #1D5FA8.")).toBeVisible()
  await expect(code).toHaveAttribute("aria-invalid", "true")
  expect(await token(page, "--primary-fill")).toBe("#7cc4ec")
  // Lo que sigue en uso se dice siempre, con su nombre.
  await expect(block.getByText("Tus pacientes ven:")).toBeVisible()
  await expect(block.getByText("#7CC4EC", { exact: true })).toBeVisible()
  // Corregido el código, el aviso se va.
  await code.fill("#7CC4EC")
  await code.blur()
  await expect(code).not.toHaveAttribute("aria-invalid", "true")
  await expect(block.getByText(/Le falta/)).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await testInfo.attach("eleccion-celular", { body: await block.screenshot(), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
  // En oscuro el celeste también se lee: la app entera, para revisarla a ojo.
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  expect(await token(page, "--primary-fill")).toBe("#7cc4ec")
  await testInfo.attach("app-oscuro", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await testInfo.attach("app-claro", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Los grises no siguen al color: con naranja quedan sin tono, ni rosados ni azulados,
  // el menú es blanco en claro y en oscuro el fondo es carbón neutro.
  await block.getByRole("button", { name: "Naranja", exact: true }).click()
  await block.getByRole("button", { name: "Usar este color" }).click()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#cc4d0a")
  expect(await token(page, "--canvas")).toBe("#f8f8f8")
  // La hoja compilada escribe el blanco corto.
  expect(["#fff", "#ffffff"]).toContain(await token(page, "--card"))
  expect(["#fff", "#ffffff"]).toContain(await token(page, "--sidebar"))
  expect(await token(page, "--muted-foreground")).toBe("#545454")
  // Los campos se ven: un borde de 3:1 sobre la tarjeta, no solo un relleno gris.
  expect(await token(page, "--input-border")).toBe("#868686")
  const tradeName = page.getByLabel("Nombre comercial")
  expect(await tradeName.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(134, 134, 134)")
  await settled(page)
  await testInfo.attach("naranja-claro", { body: await page.screenshot(), contentType: "image/png" })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  expect(await token(page, "--card")).toBe("#1e1e1e")
  await settled(page)
  await testInfo.attach("naranja-oscuro", { body: await page.screenshot(), contentType: "image/png" })
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // La invitación al equipo es de la clínica: el botón va en su naranja; la cabecera, en odentIA.
  const invitee = `equipo-${org.slug}@test.dev`
  await gotoHydrated(page, tenant(org.slug, "/settings/team"))
  await page.getByRole("button", { name: "Invitar al equipo" }).click()
  await page.getByLabel("Invitar por correo").fill(invitee)
  await page.getByRole("button", { name: "Invitar", exact: true }).click()
  await expect(page.getByRole("region", { name: "Invitaciones pendientes" }).getByText(invitee)).toBeVisible()
  const invitation = await latestHtmlFor(invitee, "Te invitaron a")
  expect(invitation).toContain("background-color:#cc4d0a;")
  expect(invitation).toContain("cid:logotipo-claro@odentia")
  await gotoHydrated(page, tenant(org.slug, "/settings"))

  // Sacar el color de una foto del letrero: se lee en el navegador y nada se guarda hasta elegir.
  const photo = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 200
    canvas.height = 120
    const context = canvas.getContext("2d")
    if (!context) throw new Error("sin canvas")
    context.fillStyle = "#dddddd"
    context.fillRect(0, 0, 200, 120)
    context.fillStyle = "#1d5fa8"
    context.fillRect(40, 30, 120, 60)
    return canvas.toDataURL("image/png").split(",")[1] ?? ""
  })
  await block.locator('input[type="file"]').setInputFiles({ name: "letrero.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") })
  const fromPhoto = block.getByRole("group", { name: "De tu foto" })
  await expect(fromPhoto.getByRole("button", { name: "Azul", exact: true })).toBeVisible()
  await expect(fromPhoto.getByText("La foto no se guarda.", { exact: false })).toBeVisible()
  // Tocar el letrero en la foto elige su color; la app sigue en naranja hasta «Usar este color».
  await fromPhoto.getByRole("img").click({ position: { x: 20, y: 20 } })
  await fromPhoto.getByRole("img").click()
  // El color tocado se nombra aparte, para no confundirlo con uno sacado de la foto.
  await expect(fromPhoto.getByRole("button", { name: "Azul, donde tocaste", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(block.getByText("Aún no se guarda")).toBeVisible()
  expect(await token(page, "--primary-fill")).toBe("#cc4d0a")
  await testInfo.attach("de-una-foto", { body: await block.screenshot(), contentType: "image/png" })
  await block.getByRole("button", { name: "Naranja", exact: true }).click()

  // Volver al de fábrica quita el color: la cabecera ya no lo escribe.
  await block.getByRole("button", { name: "Volver al turquesa de odentIA" }).click()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#0e7490")
  const clean = await serverHtml(page, tenant(org.slug, "/settings"))
  expect(clean).not.toContain("--primary-fill:#")
})
