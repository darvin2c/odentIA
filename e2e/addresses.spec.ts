import { createHash, randomBytes } from "node:crypto"
import { appointmentBookingLink } from "@odentia/db/schema/agenda"
import { PANEL, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Direcciones (issue 36, ADR 0077): la sede se busca en Google y guarda su
 * ficha para «Cómo llegar»; la dirección del paciente se completa sola con
 * Geoapify; la reserva dice cómo llegar. Los proveedores son los de
 * demostración del entorno (`fake`): no acreditan a Google ni a Geoapify.
 */

test("la sede: se busca por su nombre, se llena lo demás y su ficha abre «Cómo llegar»", async ({ owner }, testInfo) => {
  const { page, org } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/settings/branches"))
  await expect(page.getByRole("heading", { name: "Sedes", level: 1 })).toBeVisible()
  // Sin dirección, la fila lo dice y ofrece agregarla.
  const row = page.getByRole("row", { name: /Sede Central/ })
  await expect(row).toContainText("Sin dirección")
  await row.getByRole("button", { name: "Agregarla" }).click()

  const street = page.getByLabel("Calle y número")
  await street.fill("José Larco")
  const listbox = page.getByRole("listbox", { name: "Direcciones sugeridas" })
  await expect(listbox.getByRole("option", { name: /Clínica de prueba Miraflores/ })).toBeVisible()
  // La mención que piden las condiciones del proveedor va en la lista.
  await expect(page.getByText("Google Maps (prueba)")).toBeVisible()
  await shot("sede-sugerencias")
  await listbox.getByRole("option", { name: /Clínica de prueba Miraflores/ }).click()

  await expect(street).toHaveValue("Av. José Larco 345")
  await expect(page.getByLabel("Distrito")).toHaveValue("Miraflores")
  await expect(page.getByLabel("Provincia")).toHaveValue("Lima")
  await expect(page.getByLabel("Departamento")).toContainText("Lima Metropolitana")
  await expect(page.getByText("«Cómo llegar» abre su ficha de Google Maps")).toBeVisible()
  await expect(page.getByText("Clínica de prueba Miraflores")).toBeVisible()
  await expect(page.getByText(/Lo llenó Google Maps; puedes corregirlo/)).toBeVisible()
  await shot("sede-elegida")
  await page.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.getByText("Sede guardada", { exact: true })).toBeVisible()

  await expect(row).toContainText("Av. José Larco 345")
  await expect(row).toContainText("Miraflores, Lima Metropolitana")
  await row.getByRole("button", { name: "Acciones de Sede Central" }).click()
  await expect(page.getByRole("menuitem", { name: "Cómo llegar" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Copiar el enlace para llegar" })).toBeVisible()
  await shot("sedes-lista")
  await page.keyboard.press("Escape")

  // Lo guardado: la región de la lista ISO, el país de la clínica, la ficha y el enlace corto.
  const [saved] = await call<Array<{ region: string; country: string; googlePlaceId: string; slug: string }>>(page, "GET", "/api/branches", org.slug)
  expect(saved).toMatchObject({ region: "PE-LMA", country: "PE", googlePlaceId: "fake-place", slug: "central" })
  // El enlace corto lleva a la ficha en Google Maps; uno que no existe, a ningún lado.
  const directions = await api<{ data: { url: string } }>(page, "GET", `/api/public/booking/${org.slug}/directions/central`, undefined)
  expect(directions.status).toBe(200)
  expect(directions.body.data.url).toContain("query_place_id=fake-place")
  const anon = await page.context().browser()!.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const visitor = await anon.newPage()
    await gotoHydrated(visitor, tenant(org.slug, "/llegar/no-existe"))
    await expect(visitor.getByText("Este enlace ya no sirve")).toBeVisible()
  } finally {
    await anon.close()
  }
})

test("el paciente: la dirección se completa sola, se corrige y se guarda", async ({ owner }, testInfo) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Mariana Soto", docType: "DNI", docNumber: "87654321" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}?tab=filiacion`))
  // Exacto: el cajón «Editar contacto» también es una región.
  const contact = page.getByRole("region", { name: "Contacto", exact: true })
  await contact.getByRole("button", { name: "Editar", exact: true }).click()

  const street = page.getByLabel("Calle y número")
  await street.fill("Jr. Las Begonias")
  const option = page.getByRole("listbox", { name: "Direcciones sugeridas" }).getByRole("option", { name: /Jr\. Las Begonias 345/ })
  await expect(option).toBeVisible()
  await expect(page.getByText("Powered by Geoapify · © OpenStreetMap (prueba)")).toBeVisible()
  await testInfo.attach("paciente-sugerencias", { body: await page.screenshot(), contentType: "image/png" })
  await option.click()
  await expect(street).toHaveValue("Jr. Las Begonias 345")
  await expect(page.getByLabel("Distrito")).toHaveValue("Miraflores")
  await expect(page.getByLabel("Provincia")).toHaveValue("Lima")
  // Lo llenado se corrige a mano: el dpto. va en la calle. La lista vuelve a sugerir y no obliga:
  // Esc la cierra sin cerrar el cajón, y se guarda lo escrito.
  await street.fill("Jr. Las Begonias 345, dpto. 302")
  await expect(page.getByRole("listbox", { name: "Direcciones sugeridas" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("listbox", { name: "Direcciones sugeridas" })).toBeHidden()
  await expect(street).toHaveValue("Jr. Las Begonias 345, dpto. 302")
  await page.screenshot({ path: testInfo.outputPath("paciente-elegida.png") })
  await page.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(contact).toContainText("Jr. Las Begonias 345, dpto. 302 · Miraflores, Lima Metropolitana")
})

test("la reserva por enlace dice cómo llegar a la sede", async ({ owner, fixtureDb }, testInfo) => {
  const { page, org } = owner
  await call(page, "PATCH", `/api/branches/${owner.branchId}`, org.slug, {
    addressLine1: "Av. José Larco 345",
    city: "Miraflores",
    region: "PE-LMA",
    googlePlaceId: "fake-place",
  })
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Rosa Quispe", docType: "DNI", docNumber: "45678123" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const detail = await call<{ contacts: Array<{ contactId: string }> }>(page, "GET", `/api/patients/${patient.id}`, org.slug)
  const personId = detail.contacts[0]!.contactId
  const token = randomBytes(32).toString("hex")
  await fixtureDb.insert(appointmentBookingLink).values({
    organizationId: org.id,
    contactId: personId,
    patientId: patient.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  const anon = await page.context().browser()!.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  try {
    const visitor = await anon.newPage()
    await gotoHydrated(visitor, tenant(org.slug, `/reserva?token=${token}`))
    await expect(visitor.getByRole("heading", { name: "Elige tu cita" })).toBeVisible()
    const howTo = visitor.getByRole("link", { name: "Cómo llegar" })
    await expect(howTo).toBeVisible()
    await expect(howTo).toHaveAttribute("href", /google\.com\/maps\/search\/\?api=1&query=.*query_place_id=fake-place/)
    await visitor.screenshot({ path: testInfo.outputPath("reserva-como-llegar.png") })
  } finally {
    await anon.close()
  }
})
