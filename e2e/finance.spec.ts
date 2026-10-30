import { tenant } from "./env"
import { call, chooseOption, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

type Closure = { countedCents: number; expectedCents: number; differenceCents: number }

for (const viewport of [
  { name: "escritorio", width: 1280, height: 720 },
  { name: "teléfono", width: 390, height: 844 },
]) {
  test(`caja (${viewport.name}): cobrar con dos medios, anular, volver a cobrar y cerrar`, async ({
    owner,
  }) => {
    const ids = await buildClinicalBase(owner)
    const { budgetLineId } = await createAcceptedBudget(owner, ids)
    const { page } = owner
    const slug = owner.org.slug
    // La deuda nace del tratamiento aceptado: Caja la ve sin que nadie la anote.
    await call(page, "POST", `${patientApiPath(ids.patientId)}/charges`, slug, {
      budgetItemId: budgetLineId,
    }, 201)
    await page.setViewportSize(viewport)
    const shot = (name: string) =>
      page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
    // En el escritorio cada fila trae «Cobrar»; en el teléfono se cobra desde la barra de abajo, eligiendo a la persona.
    const phone = viewport.width < 640
    const collectLucia = async () => {
      if (!phone) {
        await page.getByRole("main").getByRole("button", { name: "Cobrar a Lucía Quispe" }).click()
        return
      }
      await page.getByRole("main").getByRole("button", { name: "Cobrar", exact: true }).last().click()
      await surface(page, { name: "Cobrar", exact: true }).getByLabel("Paciente", { exact: true }).fill("Lucía")
      await page.getByRole("option", { name: /Lucía Quispe/ }).click()
    }
    // En el escritorio «Cerrar caja» va en ⋯ de la cabecera; en el teléfono, en la barra de abajo.
    const openClose = async () => {
      if (phone) {
        await page.getByRole("button", { name: "Cerrar caja", exact: true }).first().click()
        return
      }
      await page.getByRole("button", { name: "Más opciones", exact: true }).click()
      await page.getByRole("menuitem", { name: "Cerrar caja" }).click()
    }

    await gotoHydrated(page, tenant(slug, "/finance"))
    const main = page.getByRole("main")
    await expect(main.getByText("Lucía Quispe").first()).toBeVisible()
    await shot("caja-con-deuda")

    // Cobro en dos medios: 200 en efectivo y 250 por otro medio, en un solo ticket.
    await collectLucia()
    const drawer = surface(page, { name: "Cobrar", exact: true })
    await expect(drawer.getByLabel("Importe", { exact: true })).toHaveValue("450.00")
    await drawer.getByRole("button", { name: "Añadir otro medio" }).click()
    await chooseOption(drawer.getByLabel("Medio de pago 2", { exact: true }), { label: "Yape" })
    await drawer.getByLabel("Importe por Efectivo").fill("200")
    await drawer.getByLabel("Importe por Yape").fill("250")
    await shot("cobrar-dos-medios")
    await drawer.getByRole("button", { name: /^Cobrar S\/\s*450\.00/ }).click()
    const ticket = page.getByRole("article", { name: /^Ticket / })
    await expect(ticket).toBeVisible()
    await expect(ticket.getByText("Yape").first()).toBeVisible()
    await shot("ticket")

    // Solo el efectivo cuenta como efectivo en caja.
    const cash = await call<{ cashOnHandCents: number; tickets: number }>(
      page,
      "GET",
      `/api/finance/cash?branchId=${owner.branchId}`,
      slug,
    )
    expect(cash.cashOnHandCents).toBe(20000)
    expect(cash.tickets).toBe(1)

    // Anular el ticket (un error al cobrar) devuelve la deuda completa y la caja a cero.
    await page.getByRole("button", { name: "Anular ticket" }).click()
    const voidDrawer = surface(page, { name: "Anular ticket", exact: true })
    await voidDrawer.getByLabel("Motivo", { exact: true }).fill("Se cobró a la persona equivocada")
    await voidDrawer.getByRole("button", { name: "Anular ticket", exact: true }).click()
    await expect(page.getByRole("article", { name: /anulado/ })).toBeVisible()
    await shot("ticket-anulado")
    const afterVoid = await call<{ cashOnHandCents: number }>(
      page,
      "GET",
      `/api/finance/cash?branchId=${owner.branchId}`,
      slug,
    )
    expect(afterVoid.cashOnHandCents).toBe(0)

    // Se vuelve a cobrar una parte en efectivo y se cierra la caja contando eso.
    await gotoHydrated(page, tenant(slug, "/finance"))
    await collectLucia()
    const second = surface(page, { name: "Cobrar", exact: true })
    await second.getByLabel("Importe", { exact: true }).fill("100")
    await second.getByRole("button", { name: /^Cobrar S\/\s*100\.00/ }).click()
    await expect(page.getByRole("article", { name: /^Ticket / })).toBeVisible()

    await gotoHydrated(page, tenant(slug, "/finance"))
    // Caja es el día: quien salió hoy de su atención con algo por pagar.
    await expect(page.getByRole("main").getByRole("heading", { name: "Por cobrar ahora" })).toBeVisible()
    await expect(page.getByRole("main").getByText(/350\.00/).first()).toBeVisible()
    await shot("caja-con-movimientos")
    // El cobro anulado sigue a la vista, marcado, y cada renglón abre su ticket.
    await expect(page.getByRole("main").getByText("Anulado").first()).toBeVisible()
    await page.getByRole("main").getByRole("button", { name: /^Ver el ticket/ }).first().click()
    await expect(page.getByRole("article", { name: /^Ticket / })).toBeVisible()
    await shot("ver-ticket")

    // Cobros: todos los tickets con su detalle y lo que suma lo que se ve; lo anulado no suma.
    await gotoHydrated(page, tenant(slug, "/finance?tab=cobros"))
    const tickets = page.getByRole("main")
    await expect(tickets.getByRole("button", { name: /^Ver el ticket/ })).toHaveCount(2)
    await expect(tickets).toContainText(/1 ticket · S\/\s*100\.00/)
    await expect(tickets.getByText("Anulado").first()).toBeVisible()
    await shot("cobros")
    // Cada filtro dice su nombre y lo elegido; queda en la dirección.
    await tickets.getByRole("button", { name: "Estado", exact: true }).click()
    await page.getByRole("option", { name: "Anulados" }).click()
    await expect(page).toHaveURL(/estado=anulados/)
    await expect(tickets.getByRole("button", { name: /^Ver el ticket/ })).toHaveCount(1)
    await tickets.getByRole("button", { name: /^Ver el ticket/ }).click()
    await expect(page.getByRole("article", { name: /anulado/ })).toBeVisible()
    await shot("cobros-anulados")
    // La búsqueda por nombre, sin tildes, encuentra los dos tickets de Lucía.
    await gotoHydrated(page, tenant(slug, "/finance?tab=cobros&q=lucia"))
    await expect(page.getByRole("main").getByRole("button", { name: /^Ver el ticket/ })).toHaveCount(2)

    // Deudas: quién debe, lo que falta y la próxima cita, con la misma barra.
    await gotoHydrated(page, tenant(slug, "/finance?tab=deudas"))
    await expect(page.getByRole("main").getByText("Lucía Quispe").first()).toBeVisible()
    await expect(page.getByRole("main").getByText(/350\.00/).first()).toBeVisible()
    await shot("deudas")

    // Comisiones vive como pestaña de Finanzas y la ruta antigua lleva ahí.
    await gotoHydrated(page, tenant(slug, "/commissions"))
    await expect(page).toHaveURL(/\/finance\?.*tab=comisiones/)
    await expect(page.getByRole("tab", { name: "Comisiones" })).toHaveAttribute("aria-selected", "true")
    await shot("comisiones")
    await gotoHydrated(page, tenant(slug, "/finance"))
    await openClose()
    const close = surface(page, { name: /^Cerrar caja/ })
    await close.getByLabel("1. Efectivo que contaste").fill("100")
    await shot("cerrar-caja")
    await close.getByRole("button", { name: "Cerrar caja", exact: true }).click()
    await expect(surface(page, { name: "Hoja de cierre", exact: true })).toBeVisible()
    await shot("hoja-de-cierre")

    const closures = await call<Closure[]>(
      page,
      "GET",
      `/api/finance/closures?branchId=${owner.branchId}`,
      slug,
    )
    expect(closures).toHaveLength(1)
    expect(closures[0]).toMatchObject({
      countedCents: 10000,
      expectedCents: 10000,
      differenceCents: 0,
    })
  })
}
