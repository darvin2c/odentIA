/**
 * Presupuesto con caminos (ADR 0153): en la atención se marca «otro camino»
 * para la misma pieza; el plan los agrupa fuera de las fases; recepción anota
 * «acepta lo común, lo de la 46 lo piensa» sin elegir; el camino que no eligió
 * deja de pedir su consentimiento en la atención; y la revisión de un precio
 * dice qué cambió y pregunta solo por eso.
 */
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

test("caminos: se marcan en la atención, lo común se acepta sin elegir y la revisión dice qué cambió", async ({ owner }, testInfo) => {
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const views = async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", slug)
  const specialtyId = (specialties.find((item) => item.key === "odontologia_general") ?? specialties[0])!.id
  const service = (name: string, priceCents: number, scope = "tooth") =>
    call<{ id: string }>(page, "POST", "/api/services", slug, {
      name,
      specialtyId,
      scope,
      priceCents,
      currency: "PEN",
      officialCode: "D3310",
    }, 201)
  const [limpieza, endodoncia, corona, exodoncia] = await Promise.all([
    service("Limpieza dental", 12000, "general"),
    service("Endodoncia molar", 65000),
    service("Corona cerámica", 90000),
    service("Exodoncia simple", 15000),
  ])
  // Segunda atención: la 46 con dos caminos y una limpieza.
  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Molestia en la 46" }, 201)
  const indicate = (serviceId: string, toothNumber: number | null) =>
    call<{ id: string }>(page, "POST", `${apiPath}/plan/items`, slug, {
      serviceId,
      sourceEncounterId: visit.id,
      ...(toothNumber ? { toothNumber } : {}),
    }, 201)
  const limpiezaItem = await indicate(limpieza.id, null)
  const endoItem = await indicate(endodoncia.id, 46)
  const coronaItem = await indicate(corona.id, 46)
  const exoItem = await indicate(exodoncia.id, 46)
  // Cada camino pide su consentimiento: la endodoncia el suyo y la exodoncia el suyo.
  const sections = {
    procedure: "Tratamiento de la pieza con anestesia local.",
    benefits: ["Quitar el dolor"],
    risks: ["Dolor los primeros días"],
    alternatives: ["Otro tratamiento"],
    consequences: "La infección puede avanzar.",
  }
  for (const [key, title, serviceId] of [
    ["e2e-endodoncia", "Consentimiento de endodoncia", endodoncia.id],
    ["e2e-exodoncia", "Consentimiento de exodoncia", exodoncia.id],
  ] as const) {
    const template = await call<{ id: string }>(page, "POST", "/api/clinical-forms/consent-templates", slug, { key, title, sections }, 201)
    await call(page, "POST", `/api/clinical-forms/consent-templates/${template.id}/publish`, slug, {}, 201)
    await call(page, "PUT", `/api/clinical-forms/consent-templates/${template.id}/services`, slug, { serviceIds: [serviceId] })
  }
  const consentAsked = async () =>
    (
      await call<Array<{ title: string }>>(
        page,
        "GET",
        `/api/clinical-forms/consent-needs?patientId=${ids.patientId}&encounterId=${visit.id}`,
        slug,
      )
    ).map((need) => need.title)

  // En la atención, la exodoncia pregunta si es otro camino para la 46.
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit.id}`))
  await page
    .getByText("Plan y controles", { exact: true })
    .first()
    .locator("xpath=ancestor::*[.//button][1]")
    .getByRole("button", { name: "Abrir", exact: true })
    .click()
  const panel = page
  const question = panel.getByRole("group", { name: /es otro camino o va también/ })
  await expect(question).toBeVisible()
  await shot("atencion-pregunta")
  await question.getByRole("button", { name: "Es otro camino", exact: true }).click()
  await expect(panel.getByText(/dos opciones/).first()).toBeVisible()
  await expect(panel.getByText("Cada opción tiene su total: nunca se suman.")).toBeVisible()
  // Cada camino se llama como en el papel, «Opción A», y dice su total (QA del 8 nov).
  await expect(panel.getByRole("region", { name: /^Opción A: / })).toContainText(/Total[^:]*: S\//)
  await expect(panel.getByRole("region", { name: /^Opción B: / })).toContainText(/Total[^:]*: S\//)
  await views("atencion-caminos")

  // El presupuesto nació con dos opciones; se entrega.
  const budgets = await call<Array<{ id: string; status: string; options: Array<{ id: string; position: number }> }>>(
    page,
    "GET",
    `${apiPath}/budgets`,
    slug,
  )
  const draft = budgets.find((budget) => budget.status === "borrador")!
  expect(draft.options).toHaveLength(2)
  await call(page, "POST", `${apiPath}/budgets/${draft.id}/deliver`, slug, {})

  // En el plan, la 46 está por decidir, fuera de las fases.
  const person = await call<{ personId: string }>(page, "GET", `/api/people/by-patient/${ids.patientId}`, slug)
  await gotoHydrated(page, tenant(slug, `/people/${person.personId}?tab=plan`))
  await expect(page.getByText(/por decidir entre dos opciones/).first()).toBeVisible()
  await views("plan-caminos")

  // «¿Qué respondió?» de «Qué sigue» abre directo su cajón: acepta la limpieza y lo de la 46 lo piensa, sin elegir.
  await page.getByRole("button", { name: "¿Qué respondió?", exact: true }).first().click()
  const drawer = surface(page, { name: /^¿Qué respondió / })
  await expect(drawer.getByText(/Va en (las dos|todas las) opciones/)).toBeVisible()
  // Lo común: la limpieza y la endodoncia de la 36 las acepta.
  for (const group of await drawer.getByRole("group", { name: /^Respuesta para / }).all())
    await group.getByRole("button", { name: "Acepta", exact: true }).click()
  await drawer.getByRole("radio", { name: /Lo piensa/ }).click()
  await views("respuesta-sin-elegir")
  await drawer.getByRole("button", { name: /Guardar la respuesta/ }).click()
  await expect(drawer).toBeHidden()
  // Guardado: la 46 sigue agrupada por decidir y el presupuesto dice que falta elegir.
  await expect(page.getByText(/falta elegir el camino/).first()).toBeVisible()
  await expect(page.getByText(/por decidir entre dos opciones/).first()).toBeVisible()
  await views("respondio-lo-comun")

  // El servidor: la limpieza aceptada, lo de la 46 pensándolo, sin opción elegida.
  const answered = await call<{ status: string; awaitsAnswer: boolean; options: Array<{ decision: string }>; items: Array<{ planItemId: string; decision: string }> }>(
    page,
    "GET",
    `${apiPath}/budgets/${draft.id}`,
    slug,
  )
  expect(answered).toMatchObject({ status: "parcial", awaitsAnswer: true })
  expect(answered.options.map((option) => option.decision)).toEqual(["pendiente", "pendiente"])
  const decisionOf = (id: string) => answered.items.find((line) => line.planItemId === id)?.decision
  expect(decisionOf(ids.itemId)).toBe("aceptado")
  expect([limpiezaItem, endoItem, coronaItem, exoItem].map((item) => decisionOf(item.id))).toEqual([
    "aceptado",
    "pospuesto",
    "pospuesto",
    "pospuesto",
  ])

  // Mientras lo piensa, la atención pide los dos consentimientos; el de la exodoncia ya se preparó.
  expect((await consentAsked()).sort()).toEqual(["Consentimiento de endodoncia", "Consentimiento de exodoncia"])
  await call(page, "POST", "/api/clinical-forms/consent-needs/prepare", slug, {
    patientId: ids.patientId,
    encounterId: visit.id,
    templateKeys: ["e2e-exodoncia"],
  }, 201)

  // Elige conservar: la exodoncia que no eligió deja de pedir su consentimiento.
  const conservar = draft.options.find((option) => option.position === 1)!
  await call(page, "POST", `${apiPath}/budgets/${draft.id}/decision`, slug, {
    optionId: conservar.id,
    decisions: [
      { planItemId: endoItem.id, decision: "aceptado" },
      { planItemId: coronaItem.id, decision: "aceptado" },
    ],
  })
  expect(await consentAsked()).toEqual(["Consentimiento de endodoncia"])
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit.id}`))
  const asks = page.getByText(/^Necesita consentimiento · /).first()
  await expect(asks).toHaveText("Necesita consentimiento · Consentimiento de endodoncia")
  // El de la exodoncia, ya preparado, sigue a la vista pero no se ofrece para firmar.
  await page
    .getByText("Documentos", { exact: true })
    .first()
    .locator("xpath=ancestor::*[.//button][1]")
    .getByRole("button", { name: "Abrir", exact: true })
    .click()
  await expect(page.getByText("Ya no se pide: no lo aceptó o eligió otra opción")).toBeVisible()
  await expect(page.getByText(/^Faltan? las? firmas? de /)).toHaveCount(0)
  await views("atencion-camino-elegido")

  // Después sube la corona: la revisión pregunta solo por ella.
  const revision = await call<{ id: string }>(page, "POST", `${apiPath}/budgets/${draft.id}/revise`, slug, {
    itemIds: [ids.itemId, limpiezaItem.id, endoItem.id, coronaItem.id],
    reason: "Sube el laboratorio",
  }, 201)
  await call(page, "POST", `${apiPath}/budgets/${revision.id}/lines`, slug, {
    lines: [{ planItemId: coronaItem.id, priceCents: 100000 }],
  })
  await gotoHydrated(page, tenant(slug, `/people/${person.personId}?tab=plan&budgetId=${revision.id}`))
  await expect(page.getByText("Qué cambió:").first()).toBeVisible()
  await expect(page.getByText(/sube de S\/\s?900\.00 a S\/\s?1,000\.00/).first()).toBeVisible()
  await views("revision-que-cambio")
  await call(page, "POST", `${apiPath}/budgets/${revision.id}/deliver`, slug, {})
  const sent = await call<{ items: Array<{ planItemId: string; decision: string }> }>(page, "GET", `${apiPath}/budgets/${revision.id}`, slug)
  expect(sent.items.find((line) => line.planItemId === coronaItem.id)?.decision).toBe("pendiente")
  expect(sent.items.find((line) => line.planItemId === endoItem.id)?.decision).toBe("aceptado")
  await gotoHydrated(page, tenant(slug, `/people/${person.personId}?tab=plan`))
  await expect(page.getByText(/precio nuevo por responder/i).first()).toBeVisible()
  await views("plan-tras-revision")
})

test("caminos: la revisión sin camino elegido lleva los dos caminos", async ({ owner }, testInfo) => {
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", slug)
  const specialtyId = (specialties.find((item) => item.key === "odontologia_general") ?? specialties[0])!.id
  const service = (name: string, priceCents: number) =>
    call<{ id: string }>(page, "POST", "/api/services", slug, {
      name,
      specialtyId,
      scope: "tooth",
      priceCents,
      currency: "PEN",
      officialCode: "D3310",
    }, 201)
  const [endodoncia, exodoncia] = await Promise.all([
    service("Endodoncia molar", 65000),
    service("Exodoncia simple", 15000),
  ])
  // La 46 se conserva o se extrae; nadie eligió todavía.
  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Molestia en la 46" }, 201)
  const indicate = (serviceId: string) =>
    call<{ id: string }>(page, "POST", `${apiPath}/plan/items`, slug, { serviceId, sourceEncounterId: visit.id, toothNumber: 46 }, 201)
  const endoItem = await indicate(endodoncia.id)
  const exoItem = await indicate(exodoncia.id)
  await call(page, "POST", `${apiPath}/budgets/paths`, slug, { encounterId: visit.id, planItemId: exoItem.id, path: "nuevo" })
  const budgets = await call<Array<{ id: string; status: string; options: Array<{ id: string }> }>>(page, "GET", `${apiPath}/budgets`, slug)
  const draft = budgets.find((budget) => budget.status === "borrador")!
  expect(draft.options).toHaveLength(2)
  await call(page, "POST", `${apiPath}/budgets/${draft.id}/deliver`, slug, {})

  // «Crear revisión» desde el Plan: el cajón lista lo de los dos caminos y lo manda todo.
  const person = await call<{ personId: string }>(page, "GET", `/api/people/by-patient/${ids.patientId}`, slug)
  await gotoHydrated(page, tenant(slug, `/people/${person.personId}?tab=plan&budgetId=${draft.id}`))
  await page.getByRole("button", { name: "Crear revisión", exact: true }).click()
  // En escritorio el cajón es el panel lateral; en el teléfono, un diálogo.
  const title = "Crear revisión del presupuesto"
  const drawer = page.getByRole("region", { name: title }).or(page.getByRole("dialog", { name: title }))
  await expect(drawer.getByRole("checkbox", { name: /Endodoncia molar/ })).toBeChecked()
  await expect(drawer.getByRole("checkbox", { name: /Exodoncia simple/ })).toBeChecked()
  await shot("revision-dos-caminos")
  // Desmarcar lo único de la Opción B la quitaría: se dice ahí mismo, sin frenar.
  const exo = drawer.getByRole("checkbox", { name: /Exodoncia simple/ })
  await exo.click()
  await expect(drawer.getByRole("status").filter({ hasText: /Opción B/ })).toBeVisible()
  await shot("revision-sin-opcion-b")
  await exo.click()
  await expect(drawer.getByRole("status").filter({ hasText: /Opción B/ })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(drawer.getByRole("checkbox", { name: /Exodoncia simple/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("revision-dos-caminos-telefono.png") })
  await page.setViewportSize({ width: 1280, height: 800 })
  await drawer.getByLabel("Motivo de la revisión").fill("Cambia la fecha de vigencia")
  const revised = page.waitForResponse(
    (response) => response.url().endsWith(`/budgets/${draft.id}/revise`) && response.request().method() === "POST",
  )
  await drawer.getByRole("button", { name: "Crear revisión", exact: true }).click()
  expect((await revised).status()).toBe(201)
  await expect(drawer).toBeHidden()

  // La revisión conserva los dos caminos y no dice que se quitó nada.
  const after = await call<Array<{ id: string; status: string; supersedesBudgetId: string | null; options: Array<{ id: string }>; items: Array<{ planItemId: string; optionId: string }> }>>(
    page,
    "GET",
    `${apiPath}/budgets`,
    slug,
  )
  const revision = after.find((budget) => budget.supersedesBudgetId === draft.id)!
  expect(revision.options).toHaveLength(2)
  const optionOf = (planItemId: string) => revision.items.filter((line) => line.planItemId === planItemId).map((line) => line.optionId)
  expect(optionOf(endoItem.id)).toHaveLength(1)
  expect(optionOf(exoItem.id)).toHaveLength(1)
  expect(optionOf(endoItem.id)[0]).not.toBe(optionOf(exoItem.id)[0])
  await gotoHydrated(page, tenant(slug, `/people/${person.personId}?tab=plan&budgetId=${revision.id}`))
  await expect(page.getByRole("button", { name: /^Opción B/ }).first()).toBeVisible()
  await expect(page.getByText(/Se quita/)).toHaveCount(0)
  await shot("revision-creada")
})
