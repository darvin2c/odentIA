/**
 * El ARM de la administración (ADR 0184), de punta a punta en pantalla: un
 * cliente que se agrega a mano, lo que se anota con Kairós (con LLM_MODEL=fake
 * ordena con sus reglas fijas y lo dice), una tarea, una propuesta que sale por
 * WhatsApp y la persona marca «Salió», y todo queda en su Historial. Soporte
 * no ve Reportes ni importes, y el servidor se los niega igual.
 *
 * WhatsApp no tiene bandeja de Sallca: «Abrir WhatsApp» abre wa.me en otra
 * pestaña. Aquí esa pestaña no sale a la red: se responde en el navegador y
 * solo se comprueba a qué número y con qué texto se abrió. Que llegue es cosa
 * de la persona, que lo dice con «Salió».
 */
import { randomUUID } from "node:crypto"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import { ADMIN, enterAdmin, surface } from "./admin"
import { api, expect, test } from "./fixtures"

test("ARM: cliente a mano, anotar con Kairós, tarea, propuesta por WhatsApp que salió y su historial; Soporte sin importes", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(240_000)
  const { page, user } = owner
  const shot = (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await page.setViewportSize({ width: 1366, height: 900 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await enterAdmin(page, user.password)

  const tag = randomUUID().slice(0, 6)
  const clinic = `Clínica Arm ${tag}`
  const person = `Luis Ramos ${tag}`
  const phone = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`
  const email = `arm-${tag}@test.dev`
  // Un plan de odentIA propio del caso para armar la propuesta (no el de lista: ese es de todos).
  const planName = `Plan ARM ${tag}`
  await fixtureDb.insert(saasPlan).values({
    code: `arm-${tag}`,
    name: planName,
    product: "dental",
    currency: "USD",
    priceCents: 4900,
    creditCents: 4900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 2_000_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 10_000,
    trialDays: 30,
  })

  // --- Un cliente a mano: la clínica, su producto, su persona y cómo llegó ----------------------
  await page.goto(`${ADMIN}/clients`)
  await expect(page.getByRole("heading", { level: 1, name: "Clientes" })).toBeVisible()
  await page.getByRole("button", { name: "Nuevo cliente" }).first().click()
  const create = surface(page, "Nuevo cliente")
  await create.getByLabel("Clínica", { exact: true }).fill(clinic)
  // Nace en odentIA; el producto se elige con botones.
  await expect(create.getByRole("button", { name: /odentIA/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await create.getByLabel("Persona", { exact: true }).fill(person)
  await create.getByLabel("Celular (WhatsApp)").pressSequentially(phone)
  await create.getByLabel("Correo", { exact: true }).fill(email)
  await create.getByLabel("Cómo llegó").click()
  await page.getByRole("option", { name: "Evento" }).click()
  await shot("nuevo-cliente")
  await create.getByRole("button", { name: "Guardar cliente" }).click()
  await expect(page.getByText(`${clinic} quedó como cliente`)).toBeVisible()
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}/)
  const clientId = /\/clients\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? ""
  await expect(page.getByRole("heading", { level: 1, name: clinic })).toBeVisible()
  const next = page.getByRole("region", { name: "Próximo paso" })
  await expect(next).toContainText("Sin próximo paso")

  // --- Anotar: Kairós lo ordena en piezas, se revisan y se guarda todo junto -------------------
  await page.getByRole("button", { name: "Anotar", exact: true }).click()
  const annotate = surface(page, "Anotar")
  await annotate
    .getByLabel("¿Qué pasó?")
    .fill("Llamé a Luis, le gustó. Su socio Pedro Ruiz es quien decide. Volver a llamar mañana.")
  await annotate.getByRole("button", { name: "Ordenar" }).click()
  await expect(annotate.getByText("lo ordenó en piezas", { exact: false })).toBeVisible()
  // Sin modelo (LLM_MODEL=fake) ordena con reglas fijas, y lo dice junto a lo ordenado.
  await expect(
    annotate.getByText("Esta vez lo ordenó sin el modelo", { exact: false }),
  ).toBeVisible()
  await expect(annotate.getByRole("textbox", { name: "La tarea", exact: true })).toHaveValue(
    "Volver a llamar",
  )
  await expect(annotate.getByRole("textbox", { name: "Nombre", exact: true })).toHaveValue(
    "Pedro Ruiz",
  )
  await shot("anotar-ordenado")
  await annotate.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.getByText("Anotado, con su tarea")).toBeVisible()
  await expect(annotate).toHaveCount(0)
  await expect(next).toContainText("Volver a llamar")

  // --- Una tarea para hoy: pasa a ser el próximo paso -----------------------------------------
  await next.getByRole("button", { name: "Nueva tarea" }).click()
  const task = surface(page, "Nueva tarea")
  await task.getByLabel("Qué hay que hacer").click()
  await page.getByRole("option", { name: "Propuesta", exact: true }).click()
  await task.getByRole("textbox", { name: "La tarea", exact: true }).fill("Enviarle la propuesta")
  await task.getByRole("button", { name: "Poner la tarea" }).click()
  await expect(page.getByText("Tarea puesta para hoy")).toBeVisible()
  await expect(next).toContainText("Enviarle la propuesta")

  // --- Una propuesta: borrador, y sale por WhatsApp -------------------------------------------
  await page
    .getByRole("tablist", { name: "Secciones del cliente" })
    .getByRole("tab", { name: "Venta" })
    .click()
  await page
    .getByRole("region", { name: "Propuestas" })
    .getByRole("button", { name: "Nueva propuesta" })
    .click()
  const draft = surface(page, "Nueva propuesta")
  await draft.getByLabel("Plan").click()
  await page.getByRole("option", { name: planName }).click()
  await expect(draft).toContainText("Precio de lista: ")
  await draft.getByRole("button", { name: "Guardar borrador" }).click()
  await expect(page.getByText("Propuesta v1 guardada como borrador")).toBeVisible()
  const proposal = surface(page, "Propuesta v1")
  await expect(proposal).toContainText("Sin descuento")

  // wa.me no sale a la red: la pestaña que abre se responde aquí.
  await page
    .context()
    .route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }),
    )
  await proposal.getByRole("button", { name: "Enviar por WhatsApp" }).click()
  const write = surface(page, "Enviar la propuesta v1")
  await expect(write.getByRole("textbox", { name: "Mensaje" })).toHaveValue(
    new RegExp(`Le preparé la propuesta para ${clinic}`),
  )
  await shot("enviar-propuesta")
  const opened = page.context().waitForEvent("page")
  await write.getByRole("button", { name: "Abrir WhatsApp" }).click()
  const whatsapp = await opened
  await whatsapp.waitForURL(/^https:\/\/wa\.me\//)
  const link = new URL(whatsapp.url())
  expect(`${link.host}${link.pathname}`).toBe(`wa.me/51${phone}`)
  expect(link.searchParams.get("text")).toContain(`Le preparé la propuesta para ${clinic}`)
  await whatsapp.close()
  // Nada se da por enviado hasta que la persona lo dice.
  const went = surface(page, "¿Salió el WhatsApp?")
  await expect(went).toContainText(phone)
  await went.getByRole("button", { name: "Salió", exact: true }).click()
  await expect(page.getByText("Anotado: salió. Queda en su historial.")).toBeVisible()
  await expect(proposal.getByText("Enviada", { exact: false }).first()).toBeVisible()
  await proposal.getByRole("button", { name: "Cerrar" }).last().click()

  // --- Todo queda en su Historial -------------------------------------------------------------
  await page
    .getByRole("tablist", { name: "Secciones del cliente" })
    .getByRole("tab", { name: "Historial" })
    .click()
  const history = page.getByRole("list", { name: "Historial del cliente" })
  const entry = (title: string) => history.getByRole("listitem").filter({ hasText: title })
  await expect(entry("La llamamos")).toContainText("Volver a llamar mañana")
  await expect(entry("Le escribimos por WhatsApp")).toContainText(
    `Le preparé la propuesta para ${clinic}`,
  )
  await expect(entry("Se envió la propuesta 1")).toBeVisible()
  const prepared = entry("Se preparó la propuesta 1")
  await expect(prepared).toBeVisible()
  // Administración ve las condiciones con su importe.
  const terms = ((await prepared.locator("p").last().textContent()) ?? "").trim()
  expect(terms).toMatch(/\d/)
  await shot("historial")

  // --- Soporte: sin Reportes ni importes, y el servidor se los niega ---------------------------
  const support = await createOwner("soporte")
  await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
  await support.page.setViewportSize({ width: 1366, height: 900 })
  await enterAdmin(support.page, support.user.password)
  const nav = support.page.getByRole("navigation")
  await expect(nav.getByRole("link", { name: "Clientes" }).first()).toBeVisible()
  await expect(nav.getByRole("link", { name: "Reportes" })).toHaveCount(0)
  // Con la dirección escrita tampoco: vuelve a Hoy.
  await support.page.goto(`${ADMIN}/reports`)
  await expect(support.page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  await expect(support.page).not.toHaveURL(/\/reports/)
  for (const path of [
    "/api/admin/reports/funnel",
    "/api/admin/reports/revenue",
    "/api/admin/reports/forecast",
    `/api/admin/clients/${clientId}/proposals`,
  ]) {
    const response = await api(support.page, "GET", path, undefined)
    expect(response.status, path).toBe(403)
  }
  // La misma ficha: su historia sí, sus importes y sus propuestas no.
  await support.page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
  const seen = support.page
    .getByRole("list", { name: "Historial del cliente" })
    .getByRole("listitem")
    .filter({ hasText: "Se preparó la propuesta 1" })
  await expect(seen).toBeVisible()
  await expect(seen).not.toContainText(terms)
  await support.page
    .getByRole("tablist", { name: "Secciones del cliente" })
    .getByRole("tab", { name: "Venta" })
    .click()
  await expect(support.page.getByRole("region", { name: "La venta" })).toBeVisible()
  await expect(support.page.getByRole("region", { name: "Propuestas" })).toHaveCount(0)
  await expect(support.page.getByRole("button", { name: "Nueva propuesta" })).toHaveCount(0)
  await support.page.screenshot({ path: testInfo.outputPath("soporte-venta.png"), fullPage: true })
})
