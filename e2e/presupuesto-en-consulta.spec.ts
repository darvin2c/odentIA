/**
 * La respuesta al presupuesto en la consulta: se le muestra en la atención y lo
 * que responde se anota ahí, sin imprimir ni enviar (queda entregado al guardar),
 * en un solo cajón. Si acepta, quien decide puede firmarlo en la tablet y su hoja
 * lo dice con su firma; sin firma, dice quién lo anotó.
 */
import { API, tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { drawSignature } from "./draw-signature"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createDraftBudget, patientApiPath } from "./patients-fixture"
import { readPdfLikeACamera } from "./read-pdf"
import { surface } from "./surface"

type Budget = {
  id: string
  status: string
  presentedAt: string | null
  decidedVia: string | null
  decidedByName: string | null
  decisionSignedAt: string | null
  acceptedByName: string | null
}

async function budgetPdf(page: import("@playwright/test").Page, slug: string, patientId: string, budgetId: string) {
  const base64 = await page.evaluate(
    async ({ api, slug, patientId, budgetId }) => {
      const response = await fetch(
        `${api}/api/patients/${patientId}/financial-document-pdf?documentType=budget&documentId=${budgetId}`,
        { headers: { "x-odentia-org": slug }, credentials: "include" },
      )
      if (!response.ok) throw new Error(`PDF: ${response.status}`)
      let text = ""
      for (const byte of new Uint8Array(await response.arrayBuffer())) text += String.fromCharCode(byte)
      return btoa(text)
    },
    { api: API, slug, patientId, budgetId },
  )
  return Buffer.from(base64, "base64")
}

test("en la atención se anota qué respondió sin imprimir ni enviar, y lo que acepta se firma en la tablet si quiere", async ({
  owner,
  browser,
}, testInfo) => {
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  const { budgetId } = await createDraftBudget(owner, ids)

  // En la atención de hoy: el presupuesto por enviar ofrece anotar su respuesta.
  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Revisión del plan" }, 201)
  // Lo que indica hoy hace visible el plan de la atención; se suma al presupuesto al firmar.
  const second = await call<{ id: string }>(page, "POST", `${apiPath}/plan/items`, slug, {
    serviceId: ids.serviceId,
    sourceEncounterId: visit.id,
    toothNumber: 26,
  }, 201)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit.id}`))
  const anotar = page.getByRole("button", { name: "Anotar su respuesta", exact: true }).first()
  await expect(anotar).toBeVisible()
  await shot("atencion-franja")
  await anotar.click()

  // Un solo cajón: el tratamiento con sus tres respuestas y quién decide.
  const drawer = surface(page, { name: /¿Qué acepta/ })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText("Decide", { exact: true })).toBeVisible()
  await expect(drawer.getByText(/queda entregado en consulta, sin enviarle nada/)).toBeVisible()
  await drawer.getByRole("group", { name: /^Respuesta para / }).getByRole("button", { name: "Acepta", exact: true }).click()
  await expect(drawer.getByText(/Quedará como «Aceptó todo», anotado por ti/)).toBeVisible()
  await shot("cajon-acepta")
  await page.setViewportSize({ width: 820, height: 1180 })

  // Firmar es opcional: la tablet pasa a quien decide con la hoja de su decisión.
  await drawer.getByRole("button", { name: "Que lo firme en la tablet", exact: true }).click()
  const tablet = page.getByRole("dialog", { name: /^Firma de Lucía/ })
  await expect(tablet.getByRole("heading", { name: "Su decisión" })).toBeVisible()
  await expect(tablet.getByText("Aceptado", { exact: true })).toBeVisible()
  await expect(tablet.getByText(/Acepto lo que dice «Aceptado»/)).toBeVisible()
  // «Listo» sin firma no avanza: lo dice junto al recuadro.
  await tablet.getByRole("button", { name: "Listo", exact: true }).click()
  await expect(tablet.getByRole("alert")).toHaveText(/Falta la firma de Lucía/)
  await drawSignature(page, tablet.getByRole("img", { name: "Firma de Lucía Quispe" }))
  await shot("tablet-firma")
  await tablet.getByRole("button", { name: "Listo", exact: true }).click()
  // La tablet vuelve al profesional, que guarda.
  const confirm = page.getByRole("dialog", { name: "Guarda su respuesta" })
  await expect(confirm.getByText("Firmó Lucía Quispe.")).toBeVisible()
  await shot("tablet-guardar")
  await confirm.getByRole("button", { name: "Guardar con su firma", exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(drawer).toBeHidden()

  // El servidor: entregado y aceptado en una sola operación, con la firma de quien decide.
  const signed = await call<Budget>(page, "GET", `${apiPath}/budgets/${budgetId}`, slug)
  expect(signed).toMatchObject({ status: "aceptado", decidedVia: "clinica", acceptedByName: "Lucía Quispe" })
  expect(signed.presentedAt).not.toBeNull()
  expect(signed.decisionSignedAt).not.toBeNull()
  // Su hoja lleva la firma: un dibujo más que la del profesional.
  const read = await readPdfLikeACamera(browser, await budgetPdf(page, slug, ids.patientId, budgetId), {
    picturePath: testInfo.outputPath("hoja-firmada.png"),
  })
  expect(read.drawings).toBeGreaterThan(0)

  // Otro presupuesto, desde el Plan en el teléfono y sin firma: 3 toques (anotar, acepta, guardar).
  await page.setViewportSize({ width: 390, height: 844 })
  const draft = await call<{ id: string }>(page, "POST", `${apiPath}/budgets`, slug, {
    itemIds: [second.id],
    title: "Segunda propuesta",
  }, 201)
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=plan&planId=${ids.planId}&budgetId=${draft.id}`))
  await page.getByRole("button", { name: "Anotar su respuesta", exact: true }).first().click()
  const plan = surface(page, { name: /¿Qué acepta/ })
  await plan.getByRole("group", { name: /^Respuesta para / }).getByRole("button", { name: "Acepta", exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath("cajon-telefono.png") })
  await plan.getByRole("button", { name: "Guardar la respuesta", exact: true }).click()
  await expect(plan).toBeHidden()
  const noted = await call<Budget>(page, "GET", `${apiPath}/budgets/${draft.id}`, slug)
  expect(noted).toMatchObject({ status: "aceptado", decidedVia: "clinica", decisionSignedAt: null })
  expect(noted.decidedByName).toBeTruthy()
  // Sin firma, la ficha dice quién lo anotó: es su palabra, no la de la persona.
  await expect(page.getByText(/lo anotó .+\. Sin firma\./).first()).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await shot("plan-anotado-sin-firma")
})
