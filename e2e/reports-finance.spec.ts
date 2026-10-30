import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { patient } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import type { Page, TestInfo } from "@playwright/test"
import { tenant } from "./env"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

async function observe(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

/** El mes en curso de la clínica (Lima) y cuántos días tuvo el anterior. */
function limaMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const year = Number(parts.find((part) => part.type === "year")?.value)
  const month = Number(parts.find((part) => part.type === "month")?.value)
  return { year, month, daysLastMonth: new Date(Date.UTC(year, month - 1, 0)).getUTCDate() }
}

type Order = { id: string; orderNumber: number }

/** Un proveedor, un almacén de la sede y un producto: lo mínimo para comprar. */
async function purchaseBase(owner: OwnerFixture) {
  const { page, org } = owner
  const supplier = await call<{ id: string }>(page, "POST", "/api/inventory/suppliers", org.slug, { name: "Insumos de prueba" }, 201)
  const warehouse = await call<{ id: string }>(page, "POST", "/api/inventory/warehouses", org.slug, { branchId: owner.branchId, name: "Almacén de prueba" }, 201)
  const product = await call<{ id: string }>(page, "POST", "/api/inventory/products", org.slug, { sku: "GUA-1", name: "Guantes de prueba", unit: "caja" }, 201)
  const order = async (quantity: number, unitCostCents: number): Promise<Order> => {
    const created = await call<Order>(page, "POST", "/api/inventory/purchase-orders", org.slug, {
      supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ productId: product.id, quantity, unitCostCents }],
    }, 201)
    await call(page, "POST", `/api/inventory/purchase-orders/${created.id}/confirm`, org.slug)
    return created
  }
  const receive = (orderId: string, quantity: number) =>
    call(page, "POST", `/api/inventory/purchase-orders/${orderId}/receive`, org.slug, { idempotencyKey: randomUUID(), lines: [{ productId: product.id, quantity }] })
  return { order, receive }
}

test("una compra recibida llega a Finanzas: se avisa, se paga como gasto de Materiales y queda al día en Inventario y en Reportes", async ({ owner }, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const base = await purchaseBase(owner)
  const order = await base.order(10, 5000)
  await base.receive(order.id, 10)
  const label = `OC-${String(order.orderNumber).padStart(4, "0")}`

  // Reportes › Finanzas: lo recibido sin pagar ya es algo que se debe, aunque aún no haya cobros.
  await gotoHydrated(page, tenant(org.slug, "/reports?tab=finanzas"))
  const owed = page.getByRole("region", { name: "Lo que debes" })
  await expect(owed).toContainText("Compras recibidas sin pagar")
  await expect(owed).toContainText("500.00")
  await expect(owed).toContainText("1 compra")
  await expect(owed.getByRole("link", { name: "Ver compras" })).toBeVisible()
  await observe(page, info, "lo-que-debes")

  // Finanzas › Gastos lo avisa y el gasto de Materiales pregunta si es esa compra.
  await gotoHydrated(page, tenant(org.slug, "/finance?tab=gastos"))
  await expect(page.getByText("1 compra recibida sin pagar: S/ 500.00")).toBeVisible()
  await page.getByRole("button", { name: "Registrar gasto", exact: true }).first().click()
  const form = surface(page, { name: "Registrar gasto" })
  await form.getByRole("radio", { name: "Materiales" }).check()
  await form.getByRole("radio", { name: new RegExp(`^${label} · Insumos de prueba`) }).check()
  await expect(form.getByLabel("Importe", { exact: true })).toHaveValue("500.00")
  await expect(form.getByText("Por pagar: S/ 500.00. Puedes pagar una parte.")).toBeVisible()
  // Se pagó por transferencia: no sale del efectivo de la caja.
  await form.getByRole("checkbox", { name: "Se pagó con el efectivo de la caja" }).uncheck()
  await observe(page, info, "pagar-compra")
  await form.getByRole("button", { name: "Registrar pago" }).click()
  await expect(page.getByText(`Pago registrado: ${label} queda al día en Inventario`)).toBeVisible()
  await expect(page.getByText(`Pago de compra ${label} · Insumos de prueba`)).toBeVisible()
  await expect(page.getByText(`Compra ${label}`, { exact: true })).toBeVisible()
  await expect(page.getByText(/compras? recibidas? sin pagar/)).toHaveCount(0)

  // El mismo pago es el de la orden: Inventario la da por pagada.
  const purchases = await call<{ unpaid: { orders: number; cents: number } }>(page, "GET", `/api/finance/purchases?branchId=${owner.branchId}`, org.slug)
  expect(purchases.unpaid).toMatchObject({ orders: 0, cents: 0 })
  await gotoHydrated(page, tenant(org.slug, "/inventory?tab=compras&ver=todas"))
  const row = page.getByRole("row").filter({ hasText: label })
  await expect(row).toContainText("✓ Pagada")

  // Reportes: ya no se debe nada y el pago es un gasto de Materiales del periodo.
  await gotoHydrated(page, tenant(org.slug, "/reports?tab=finanzas"))
  await expect(owed).toContainText("Ninguna")
  const finance = await call<{ payables: { purchases: { cents: number; orders: number } } }>(page, "GET", "/api/reports/finance?period=este_mes", org.slug)
  expect(finance.payables.purchases).toMatchObject({ cents: 0, orders: 0 })
  await expect(page.getByRole("region", { name: "De lo cobrado a lo que deja el periodo" })).toContainText("Materiales")
  await observe(page, info, "reporte-al-dia")
})

test("cancelar una compra pagada pide qué pasa con lo pagado; el servidor no la deja sin elegir", async ({ owner }, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const base = await purchaseBase(owner)
  const order = await base.order(4, 5000)
  const label = `OC-${String(order.orderNumber).padStart(4, "0")}`
  // Un adelanto de lo que aún no llega.
  await call(page, "POST", `/api/finance/purchases/${order.id}/payments`, org.slug, { amountCents: 20000, fromCash: false }, 201)

  const refused = await api<{ error: { code: string } }>(page, "POST", `/api/inventory/purchase-orders/${order.id}/cancel`, org.slug, {})
  expect(refused.status).toBe(409)
  expect(refused.body.error.code).toBe("PURCHASE_HAS_PAYMENTS")

  await gotoHydrated(page, tenant(org.slug, "/inventory?tab=compras&ver=todas"))
  const row = page.getByRole("row").filter({ hasText: label })
  await expect(row).toContainText("Adelanto S/ 200.00")
  // La compra se abre al lado; cancelar está en su «⋯».
  await page.getByRole("button", { name: `${label} · Insumos de prueba`, exact: true }).click()
  await page.getByRole("button", { name: `Más acciones de ${label}` }).click()
  await page.getByRole("menuitem", { name: "Cancelar la compra" }).click()
  const dialog = page.getByRole("alertdialog", { name: `Cancelar ${label}` })
  await expect(dialog).toContainText("Esta compra ya tiene S/ 200.00 pagados")
  // Sin elegir no se cancela: el diálogo dice qué falta, junto a las opciones.
  await dialog.getByRole("button", { name: "Cancelar la compra" }).click()
  await expect(dialog).toContainText("Elige qué pasa con lo pagado.")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("radio", { name: /^Dejarlo a favor con Insumos de prueba/ }).check()
  await observe(page, info, "cancelar-pagada")
  await dialog.getByRole("button", { name: "Cancelar la compra" }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toContainText("A favor S/ 200.00")

  // Lo pagado queda a favor con el proveedor, para su próxima compra.
  const purchases = await call<{ credits: Array<{ supplierName: string; cents: number }> }>(page, "GET", "/api/finance/purchases", org.slug)
  expect(purchases.credits).toEqual([expect.objectContaining({ supplierName: "Insumos de prueba", cents: 20000 })])

  // Lo a favor paga la siguiente compra; ese uso se anula en el detalle de la compra, con motivo, y vuelve a estar a favor.
  const next = await base.order(2, 5000)
  const nextLabel = `OC-${String(next.orderNumber).padStart(4, "0")}`
  await call(page, "POST", `/api/finance/purchases/${next.id}/payments`, org.slug, { amountCents: 0, creditCents: 10000, fromCash: false }, 201)
  await gotoHydrated(page, tenant(org.slug, "/inventory?tab=compras&ver=todas"))
  await page.getByRole("button", { name: `${nextLabel} · Insumos de prueba`, exact: true }).click()
  await page.getByRole("button", { name: "Anular el uso de S/ 100.00 a favor" }).click()
  const voiding = surface(page, { name: "Anular lo usado a favor", exact: true })
  await voiding.getByLabel("Motivo", { exact: true }).fill("Se usó en la compra equivocada")
  await observe(page, info, "anular-a-favor")
  await voiding.getByRole("button", { name: "Anular", exact: true }).click()
  await expect(page.getByText("Uso anulado: vuelve a estar a favor con el proveedor y esta compra lo vuelve a deber")).toBeVisible()
  const restored = await call<{ credits: Array<{ supplierName: string; cents: number }> }>(page, "GET", "/api/finance/purchases", org.slug)
  expect(restored.credits).toEqual([expect.objectContaining({ supplierName: "Insumos de prueba", cents: 20000 })])
})

for (const width of [1440, 390]) {
  test(`horas libres a ${width}px: la agenda ocupada sale del horario de cada día, el mapa se recorre con el teclado y el Resumen dice cuánto se ocupó cada uno`, async ({ owner, fixtureDb }, info) => {
    const { page, org } = owner
    await page.setViewportSize({ width, height: 844 })
    // De 9 a 13 todos los días; se guarda hoy, así que el mes pasado usa el de hoy y lo dice.
    await call(page, "PUT", "/api/agenda/schedules", org.slug, {
      branchId: owner.branchId, professionalUserId: owner.user.id,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 780 })),
    })
    // Una cita atendida de una hora el día 10 del mes pasado, a las 10:00 de Lima.
    const { year, month, daysLastMonth } = limaMonth()
    const roomId = randomUUID()
    await fixtureDb.insert(scheduleRoom).values({ id: roomId, organizationId: org.id, branchId: owner.branchId, name: "Unidad dental de prueba" })
    const [person] = await fixtureDb.insert(contact).values({ organizationId: org.id, displayName: "Rosa Paz" }).returning({ id: contact.id })
    const patientId = randomUUID()
    await fixtureDb.insert(patient).values({ id: patientId, organizationId: org.id, personId: person!.id, patientNumber: 1 })
    const startsAt = new Date(Date.UTC(year, month - 2, 10, 15))
    await fixtureDb.insert(appointment).values({
      organizationId: org.id, branchId: owner.branchId, patientId, roomId, professionalUserId: owner.user.id,
      serviceName: "Evaluación", startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), durationMin: 60, status: "atendida",
    })

    // Cuatro horas por día del mes pasado, una ocupada: la misma cuenta en el servidor y en pantalla.
    const report = await call<{ occupancy: { current: { availMin: number; occMin: number } }; map: { assumed: boolean } }>(page, "GET", "/api/reports/agenda?period=mes_pasado", org.slug)
    expect(report.occupancy.current).toEqual({ availMin: 240 * daysLastMonth, occMin: 60 })
    expect(report.map.assumed).toBe(true)

    await gotoHydrated(page, tenant(org.slug, "/reports?tab=agenda&period=mes_pasado"))
    const busy = page.getByRole("region", { name: "Cifras de agenda" }).getByRole("region", { name: "Agenda ocupada" })
    await expect(busy).toContainText(`libres de ${daysLastMonth * 4} h`)
    const free = page.getByRole("region", { name: "Cuándo queda libre la agenda" })
    await expect(free).toContainText("Antes de que odentIA guardara su horario se usó el de hoy")
    const map = free.getByRole("figure", { name: /^Agenda ocupada día a día/ })
    const chosen = map.getByRole("button", { pressed: true })
    const before = await chosen.getAttribute("aria-label")
    await chosen.focus()
    await page.keyboard.press("ArrowLeft")
    await expect(chosen).not.toHaveAttribute("aria-label", before ?? "")
    await expect(chosen).toBeFocused()
    await observe(page, info, "horas-libres")
    await free.getByRole("button", { name: "Semana tipo" }).click()
    await expect(free.getByRole("figure", { name: /^Semana tipo de / })).toBeVisible()
    await observe(page, info, "semana-tipo")

    // Resumen › Por profesional: «Ocupado» es la misma agenda ocupada.
    await gotoHydrated(page, tenant(org.slug, "/reports?period=mes_pasado"))
    const people = page.getByRole("region", { name: "Por profesional" })
    await expect(people).toContainText("Ocupado")
    await observe(page, info, "resumen-ocupado")

    // El horario guarda desde cuándo vale.
    await gotoHydrated(page, tenant(org.slug, "/settings/availability"))
    await expect(page.getByText(/^Vigente desde el /)).toBeVisible()
  })
}
