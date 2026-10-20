import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

/**
 * Inventario por sede (ADR 0067): lo que sale de la sede sin que nadie lo
 * anote. Los materiales de un servicio se descuentan al firmar la atención y se
 * corrigen después; lo que se vende en «Cobrar» sale al agregarlo. Los datos se
 * preparan por la API; lo que se ve y se corrige, por la pantalla.
 */

type Product = { id: string }
type ProductList = { items: Array<{ id: string; onHand: number; shortage: number; salePriceCents?: number }> }

/** Un producto con lo que hay contado en la sede del dueño. */
async function productWithStock(owner: OwnerFixture, input: Record<string, unknown>, counted: number): Promise<Product> {
  const { page, org } = owner
  const product = await call<Product>(page, "POST", "/api/inventory/products", org.slug, input, 201)
  await call(page, "POST", "/api/inventory/count", org.slug, {
    branchId: owner.branchId,
    idempotencyKey: randomUUID(),
    items: [{ productId: product.id, counted }],
  })
  return product
}

async function onHand(owner: OwnerFixture, productId: string): Promise<number | undefined> {
  const list = await call<ProductList>(owner.page, "GET", `/api/inventory/products?branchId=${owner.branchId}`, owner.org.slug)
  return list.items.find((item) => item.id === productId)?.onHand
}

test("los materiales del servicio salen de la sede al firmar la atención y se corrigen después", async ({ owner }, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const ids = await buildClinicalBase(owner)
  const gloves = await productWithStock(owner, {
    name: "Guantes de prueba",
    usedInCare: true,
    unit: "par",
    purchaseUnit: "caja",
    purchaseFactor: 50,
  }, 10)
  // Cada endodoncia usa 2 pares: se configura una vez en el servicio.
  await call(page, "PUT", `/api/services/${ids.serviceId}/materials`, org.slug, { items: [{ productId: gloves.id, quantity: 2 }] })

  // Una atención en la sede con ese servicio, lista para firmar.
  const apiPath = patientApiPath(ids.patientId)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, org.slug, {
    reason: "Endodoncia pieza 36",
    branchId: owner.branchId,
  }, 201)
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/procedures`, org.slug, { serviceId: ids.serviceId, toothNumber: 36 }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, org.slug, { evolution: "Se realiza la endodoncia de la pieza 36." })
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/diagnoses`, org.slug, {
    diagnosisCode: "K02.1",
    diagnosisType: "confirmed",
    toothNumber: 36,
    surfaces: ["occlusal"],
  }, 201)
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/finalize`, org.slug, {})
  expect(await onHand(owner, gloves.id)).toBe(8)

  // La atención firmada dice qué salió y de dónde.
  await gotoHydrated(page, tenant(org.slug, `/patients/${ids.patientId}/encounters/${encounter.id}`))
  const used = page.getByRole("region", { name: "Materiales usados" })
  await expect(used).toContainText("Salieron de Sede Central")
  await expect(used).toContainText("Guantes de prueba")
  await expect(used).toContainText("2 pares")
  await info.attach("materiales-usados", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Se usó un par menos: la corrección devuelve uno a la sede y lo firmado no cambia.
  await used.getByRole("button", { name: "Corregir" }).click()
  const drawer = surface(page, { name: "Corregir materiales" })
  await drawer.getByLabel(/^Guantes de prueba/).fill("1")
  await drawer.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Listo: se usó 1 par de guantes de prueba.")).toBeVisible()
  await expect(used).toContainText("1 par")
  expect(await onHand(owner, gloves.id)).toBe(9)
})

test("vender desde «Cobrar»: el producto sale de la sede al agregarlo y va en el ticket", async ({ owner }, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const ids = await buildClinicalBase(owner)
  const rinse = await productWithStock(owner, {
    name: "Enjuague bucal de prueba",
    usedInCare: false,
    forSale: true,
    unit: "frasco",
    salePriceCents: 2800,
  }, 2)
  // Lucía ya debe una consulta: aparece en «Por cobrar».
  await call(page, "POST", `${patientApiPath(ids.patientId)}/charges`, org.slug, {
    branchId: owner.branchId,
    description: "Consulta",
    amountCents: 5000,
    currency: "PEN",
  }, 201)

  await gotoHydrated(page, tenant(org.slug, "/finance"))
  await page.getByRole("main").getByRole("button", { name: "Cobrar a Lucía Quispe" }).click()
  const drawer = surface(page, { name: "Cobrar", exact: true })
  await drawer.getByRole("button", { name: "Agregar producto" }).click()
  await drawer.getByRole("combobox", { name: "Producto" }).click()
  await page.getByRole("option", { name: /^Enjuague bucal de prueba/ }).click()
  await expect(drawer.getByText("hay 2 frascos", { exact: false })).toBeVisible()
  await drawer.getByRole("button", { name: "Agregar", exact: true }).click()
  await expect(drawer).toContainText("salió 1 de Sede Central")
  expect(await onHand(owner, rinse.id)).toBe(1)
  await info.attach("cobrar-con-producto", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  await drawer.getByRole("button", { name: /^Cobrar S\/\s*78\.00/ }).click()
  const ticket = page.getByRole("article", { name: /^Ticket / })
  await expect(ticket).toContainText("Enjuague bucal de prueba")
  await expect(ticket).toContainText("28.00")

  // Otro día lo devuelve cerrado (ADR 0068): la venta queda, el frasco vuelve a la sede y se le paga.
  await page.getByRole("button", { name: "Devolver", exact: true }).click()
  const back = surface(page, { name: "Devolver", exact: true })
  await back.getByRole("button", { name: "Uno más de Enjuague bucal de prueba" }).click()
  await expect(back.getByRole("button", { name: "Sí, está en buen estado" })).toHaveAttribute("aria-pressed", "true")
  await back.getByLabel("Motivo", { exact: true }).fill("Lo trajo cerrado")
  await expect(back).toContainText("Vuelve a Sede Central: 1 Enjuague bucal de prueba.")
  await info.attach("devolver", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await back.getByRole("button", { name: /^Devolver S\/\s*28\.00/ }).click()
  // Registrada, el mismo cajón pasa a ser la devolución con su número.
  const done = surface(page, { name: "Devolución N.º 000001", exact: true })
  await expect(done.getByText("Devolución registrada")).toBeVisible()
  await expect(done.getByRole("article", { name: /^Devolución / })).toContainText("TOTAL DEVUELTO")
  expect(await onHand(owner, rinse.id)).toBe(2)
  await done.getByRole("button", { name: "Listo" }).click()
  // El ticket sigue valiendo, con la devolución anotada, y ya no se anula.
  await expect(ticket).toContainText("Devolución 000001")
  await expect(page.getByRole("button", { name: "Anular ticket" })).toHaveCount(0)
})

test("recepción ve lo que hay y recibe, pero no ve precios ni cambia productos", async ({ owner, fixtureDb }) => {
  const { page, org } = owner
  const gloves = await productWithStock(owner, { name: "Guantes de prueba", usedInCare: true, forSale: true, unit: "par", salePriceCents: 500 }, 4)
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))

  const list = await call<ProductList>(page, "GET", `/api/inventory/products?branchId=${owner.branchId}`, org.slug)
  const row = list.items.find((item) => item.id === gloves.id)
  expect(row?.onHand).toBe(4)
  expect(row && "salePriceCents" in row).toBe(false)
  expect((await api(page, "POST", "/api/inventory/products", org.slug, { name: "Otro", unit: "unidad" })).status).toBe(403)
  expect((await api(page, "PATCH", `/api/inventory/products/${gloves.id}`, org.slug, { salePriceCents: 100 })).status).toBe(403)
  // «Registrar uso» sí: lo que se regaló en recepción.
  await call(page, "POST", "/api/inventory/usage", org.slug, {
    productId: gloves.id,
    branchId: owner.branchId,
    quantity: 1,
    note: "Se regaló en recepción",
    idempotencyKey: randomUUID(),
  }, 201)
  expect(await onHand(owner, gloves.id)).toBe(3)

  // El menú le muestra Inventario aunque no tenga inventory.read.
  await gotoHydrated(page, tenant(org.slug, "/inventory"))
  await expect(page.getByRole("heading", { level: 1, name: "Inventario" })).toBeVisible()
})
