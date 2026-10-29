/**
 * La administración en negro (ADR 0091), en pantalla: el producto de cada
 * clínica se ve como un punto con su nombre, el filtro «Producto» cuenta y
 * filtra, y la ficha de un consultorio de latidIA abre en su dominio.
 */
import { createHmac } from "node:crypto"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
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

test("la administración distingue el producto de cada clínica y filtra por él", async ({ owner, createOwner, fixtureDb }, testInfo) => {
  const { page, user } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await page.setViewportSize({ width: 1366, height: 860 })
  const medical = await createOwner("latidia")
  await fixtureDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, medical.org.id))
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })

  await page.goto(`${ADMIN}/security`)
  await expect(page.getByText("Administración", { exact: true }).first()).toBeVisible()
  await shot("codigo-claro")
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByRole("button", { name: /No puedes escanear/ }).click()
  const secret = (await page.locator("code").first().textContent()) ?? ""
  await page.getByLabel(/código de 6 dígitos/i).fill(totpNow(secret))
  await page.getByText("Los guardé en un lugar seguro").click()
  await page.getByRole("button", { name: "Entrar a la administración" }).click()
  await expect(page).not.toHaveURL(/\/security/)
  await expect(page).toHaveTitle("Administración")
  await expect(page.locator("html")).toHaveAttribute("data-brand", "admin")
  await page.goto(ADMIN)
  await expect(page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  await expect(page.getByRole("group", { name: "Producto" })).toBeVisible()
  await shot("hoy-claro")

  await page.goto(`${ADMIN}/organizations`)
  // Cada clínica es una tarjeta que lleva a su ficha.
  const list = page.getByRole("list").filter({ has: page.getByRole("link", { name: new RegExp(medical.org.name) }) })
  const medicalRow = list.getByRole("link", { name: new RegExp(medical.org.name) })
  const dentalRow = list.getByRole("link", { name: new RegExp(owner.org.name) })
  await expect(medicalRow).toContainText("latidIA")
  await expect(dentalRow).toContainText("odentIA")

  // El filtro: solo latidIA deja el consultorio y quita la clínica dental.
  const filter = page.getByRole("group", { name: "Producto" })
  await expect(filter.getByRole("button", { name: /latidIA\s*\d+/ })).toBeVisible()
  await filter.getByRole("button", { name: /latidIA/ }).click()
  await expect(medicalRow).toBeVisible()
  await expect(dentalRow).toHaveCount(0)

  // La ficha dice qué es y abre en el dominio de su producto.
  await medicalRow.click()
  await expect(page.getByText("latidIA · consultorio médico")).toBeVisible()
  await expect(page.getByRole("link", { name: new RegExp(`Abrir en ${medical.org.slug}\\.`) })).toBeVisible()
  await shot("organizaciones-claro")

  await page.evaluate(() => {
    document.documentElement.classList.add("dark")
    document.documentElement.style.colorScheme = "dark"
  })
  await shot("organizaciones-oscuro")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("organizaciones-telefono")

  // Las demás pantallas toman el tema neutro solas: se miran en claro y en oscuro.
  await page.setViewportSize({ width: 1366, height: 860 })
  for (const [path, title] of [
    ["/users", "Usuarios"],
    ["/commissions", "Comisiones"],
    ["/support", "Soporte"],
    ["/complaints", "Libro de Reclamaciones"],
    ["/team", "Equipo y actividad"],
  ] as const) {
    for (const dark of [false, true]) {
      await page.goto(`${ADMIN}${path}`)
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(title.split(" ")[0] ?? title, "i") })).toBeVisible()
      await page.evaluate((on) => {
        document.documentElement.classList.toggle("dark", on)
        document.documentElement.style.colorScheme = on ? "dark" : "light"
      }, dark)
      await page.waitForLoadState("networkidle")
      await shot(`${path.slice(1)}-${dark ? "oscuro" : "claro"}`)
    }
  }
})
