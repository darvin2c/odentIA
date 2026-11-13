/**
 * Las demos para presentar (ADR 0096), en pantalla: la administración crea una
 * demo de latidIA desde Demos, ve cómo se arma, la abre con lo que tiene para
 * mostrar, la vuelve a empezar y la borra escribiendo su nombre. La arma el
 * worker de verdad.
 */
import { createHmac, randomUUID } from "node:crypto"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import { and, desc, eq } from "drizzle-orm"
import { surface } from "./admin"
import { hostUrl } from "./env"
import { expect, test } from "./fixtures"

const ADMIN = hostUrl("admin")

function totpNow(base32: string): string {
  let bits = ""
  for (const char of base32.replace(/\s|=/g, "").toUpperCase())
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [])
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const mac = createHmac("sha1", key).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0xf
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

test("la administración crea una demo de latidIA, la ve armarse, la vuelve a empezar y la borra", async ({
  owner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(300_000)
  const { page, user } = owner
  const shot = (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await page.setViewportSize({ width: 1366, height: 900 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  // La demo se cuenta con el plan de lista de su producto: si otra prueba no lo dejó, se crea.
  const [listed] = await fixtureDb
    .select({ id: saasPlan.id })
    .from(saasPlan)
    .where(
      and(
        eq(saasPlan.product, "medical"),
        eq(saasPlan.isDefault, true),
        eq(saasPlan.isActive, true),
      ),
    )
  if (!listed) {
    await fixtureDb.insert(saasPlan).values({
      code: `demos-${randomUUID().slice(0, 8)}`,
      name: "Plan latidIA",
      product: "medical",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 2_000_000,
      trialCreditCents: 5000,
      trialMaxCreditCents: 10_000,
      trialDays: 30,
      isDefault: true,
    })
  }

  await page.goto(`${ADMIN}/security`)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByRole("button", { name: /No puedes escanear/ }).click()
  const secret = (await page.locator("code").first().textContent()) ?? ""
  await page.getByLabel(/código de 6 dígitos/i).fill(totpNow(secret))
  await page.getByText("Los guardé en un lugar seguro").click()
  await page.getByRole("button", { name: "Entrar a la administración" }).click()
  await expect(page).not.toHaveURL(/\/security/)

  // --- Crear demo (tablero 3), desde Demos --------------------------------------------------
  await page.goto(`${ADMIN}/demos`)
  await expect(page.getByRole("heading", { level: 1, name: "Demos" })).toBeVisible()
  await page.getByRole("button", { name: "Crear demo" }).first().click()
  await page
    .getByRole("radiogroup", { name: "Producto" })
    .getByRole("radio", { name: /latidIA/ })
    .check()
  await page
    .getByRole("radiogroup", { name: "Tipo de consultorio" })
    .getByRole("radio", { name: /Pediatría/ })
    .check()
  await page
    .getByRole("radiogroup", { name: "Tamaño" })
    .getByRole("radio", { name: /Pequeño/ })
    .check()
  await page.getByLabel("Historia").click()
  await page.getByRole("option", { name: "6 meses" }).click()
  const name = await page.getByLabel("Nombre").inputValue()
  expect(name).toMatch(/Pedi[aá]tr/)
  await expect(page.getByLabel("La presenta")).toContainText("(tú)")
  await shot("crear-demo")
  await page.getByRole("button", { name: "Crear demo" }).last().click()

  // --- Mientras se crea (tablero 4) y lista ---------------------------------------------------
  await expect(page.getByText("Puedes cerrar esto y seguir.")).toBeVisible()
  await shot("creando-demo")
  // Lista, el avance da paso a la demo misma: lo que tiene para mostrar y «Abrir la demo».
  const detail = surface(page, name)
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible({
    timeout: 180_000,
  })
  await expect(detail.getByRole("button", { name: "Abrir la demo" })).toBeEnabled()
  await shot("demo-lista")
  await detail.getByRole("button", { name: "Cerrar" }).last().click()

  // --- Demos, con su filtro de producto (tablero 1) -------------------------------------------
  await page.getByRole("group", { name: "Producto" }).getByRole("button", { name: /latidIA/ }).click()
  await expect(page).toHaveURL(/producto=medical/)
  const row = page.getByRole("listitem").filter({ hasText: name })
  await expect(row).toContainText("Demo")
  await expect(row).toContainText("latidIA")
  await expect(row).toContainText("Pediatría · pequeño · 6 meses · al día")
  await shot("clinicas-demos")

  // --- La ficha de una demo (tablero 2) -------------------------------------------------------
  await row.getByRole("button", { name: "Ver", exact: true }).click()
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible()
  const band = detail.getByRole("region", { name: "Demo" })
  await expect(band).toContainText("Demo de Pediatría · pequeño · 6 meses · Perú")
  await expect(detail.getByRole("heading", { name: "Lo que tiene hoy para mostrar" })).toBeVisible()
  await expect(detail.getByText("Control de niño sano")).toBeVisible()
  await shot("ficha-demo-claro")
  await page.evaluate(() => {
    document.documentElement.classList.add("dark")
    document.documentElement.style.colorScheme = "dark"
  })
  await shot("ficha-demo-oscuro")
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark")
    document.documentElement.style.colorScheme = ""
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("ficha-demo-telefono")
  await page.setViewportSize({ width: 1366, height: 900 })

  // Una demo nunca es cliente ni se factura: su página de clínica sigue siendo la suya (no lleva a
  // Clientes) y el mes lo dice, también en lo que paga.
  const [demo] = await fixtureDb
    .select({ id: saasDemo.id, organizationId: saasDemo.organizationId })
    .from(saasDemo)
    .where(eq(saasDemo.name, name))
    .orderBy(desc(saasDemo.createdAt))
    .limit(1)
  expect(demo?.organizationId).toBeTruthy()
  await page.goto(`${ADMIN}/organizations/${demo!.organizationId}`)
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/organizations/${demo!.organizationId}`))
  await expect(page.getByText("Es una demo: no se cobra")).toBeVisible()
  await page.goto(`${ADMIN}/demos?demo=${demo!.id}`)

  // --- Volver a empezar y borrar (tablero 4b) -------------------------------------------------
  await band.getByRole("button", { name: "Volver a empezar" }).click()
  await expect(page.getByRole("alertdialog")).toContainText(
    "Se borra lo que se hizo en las presentaciones",
  )
  await shot("volver-a-empezar")
  await page.getByRole("alertdialog").getByRole("button", { name: "Volver a empezar" }).click()
  // Mientras se vuelve a armar, la demo muestra su avance; al terminar, vuelve a estar lista.
  await expect(page.getByRole("heading", { name: `Creando ${name}` })).toBeVisible()
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible({
    timeout: 180_000,
  })
  await expect(detail.getByRole("region", { name: "Demo" })).toContainText("Al día hoy")

  const dialog = page.getByRole("alertdialog")
  await detail
    .getByRole("region", { name: "Demo" })
    .getByRole("button", { name: "Borrar demo" })
    .click()
  const confirmName = dialog.getByLabel("Escribe el nombre para confirmar")
  await expect(dialog).toContainText(`Escribe «${name}» tal cual`)
  // Un nombre que no coincide no borra: se dice junto al campo y el diálogo sigue abierto.
  await confirmName.fill(name.slice(0, 6))
  await dialog.getByRole("button", { name: "Borrar demo" }).click()
  await expect(confirmName).toHaveAttribute("aria-invalid", "true")
  await expect(dialog).toContainText("Escribe el nombre de la demo para borrarla")
  await shot("borrar-demo")
  await confirmName.fill(name)
  await dialog.getByRole("button", { name: "Borrar demo" }).click()
  await expect(page).toHaveURL(/\/demos(\?|$)/)
  await expect(page).not.toHaveURL(/demo=/)
  await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0)
})
