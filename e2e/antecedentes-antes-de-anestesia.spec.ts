/**
 * Antes de anestesiar (QA del 8 nov, A2): la atención pide lo que nunca se le
 * preguntó de su salud (alergias, enfermedades y medicación), cada cosa con su
 * respuesta a un toque, y lo que sí tiene se escribe en Antecedentes encima de
 * la atención. Si se descuenta un anestésico local y aún falta algo, el cierre
 * lo dice junto a los materiales; nada de esto impide firmar. Los datos se
 * preparan por la API; lo que se ve y se responde, por la pantalla.
 */
import { randomUUID } from "node:crypto"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, patientApiPath } from "./patients-fixture"

test("la atención pide sus enfermedades y su medicación, y el cierre avisa la anestesia sin frenar la firma", async ({ owner }, info) => {
  const { page, org } = owner
  const slug = org.slug
  await page.setViewportSize({ width: 1440, height: 900 })
  const shot = async (name: string) =>
    info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  // El servicio y la colegiatura salen de la base clínica; la paciente es nueva y nadie le preguntó nada.
  const ids = await buildClinicalBase(owner)
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Marta Ríos", docType: "DNI", docNumber: "41234567" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const apiPath = patientApiPath(patient.id)
  // Cada vez que se hace, el servicio descuenta un cartucho de lidocaína de la sede.
  const lidocaine = await call<{ id: string }>(page, "POST", "/api/inventory/products", slug, {
    name: "Lidocaína 2 % con epinefrina",
    usedInCare: true,
    unit: "cartucho",
  }, 201)
  await call(page, "PUT", `/api/services/${ids.serviceId}/materials`, slug, { items: [{ productId: lidocaine.id, quantity: 1 }] })
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, {
    reason: "Dolor en la 36",
    branchId: owner.branchId,
  }, 201)
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/procedures`, slug, { serviceId: ids.serviceId, toothNumber: 36 }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, slug, {
    evolution: "Anestesia infiltrativa con lidocaína; se trabaja la 36.",
  })
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/diagnoses`, slug, {
    diagnosisCode: "K02.1",
    diagnosisType: "confirmed",
    toothNumber: 36,
    surfaces: ["occlusal"],
  }, 201)

  await gotoHydrated(page, tenant(slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  // Un solo aviso con lo que falta, una fila por tema; la ASA no se elige aquí.
  const notice = page.getByRole("region", { name: "Pregúntale a Marta por sus alergias, sus enfermedades y su medicación" })
  await expect(notice).toBeVisible()
  await expect(notice.getByRole("button", { name: "No tiene alergias" })).toBeVisible()
  await expect(notice.getByRole("button", { name: "No toma medicación" })).toBeVisible()
  await expect(notice).not.toContainText("ASA")
  await shot("aviso-al-abrir")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(notice.getByRole("button", { name: "Niega enfermedades" })).toBeVisible()
  await shot("aviso-al-abrir-telefono")
  await page.setViewportSize({ width: 1440, height: 900 })

  // «Niega enfermedades» lo deja dicho y la fila se va; lo demás sigue pidiéndose.
  await notice.getByRole("button", { name: "Niega enfermedades" }).click()
  await expect(page.getByText("Anotado: niega enfermedades")).toBeVisible()
  const pending = page.getByRole("region", { name: "Pregúntale a Marta por sus alergias y su medicación" })
  await expect(pending).toBeVisible()
  await expect(pending.getByRole("button", { name: "Niega enfermedades" })).toHaveCount(0)
  const health = await call<{ reviewStatus: Record<string, string> }>(page, "GET", `${apiPath}/health`, slug)
  expect(health.reviewStatus).toMatchObject({ conditions: "none", medications: "unknown" })

  // Lo que sí tiene se escribe en Antecedentes, encima de la atención; al cerrar se sigue aquí.
  await pending.getByRole("button", { name: "Registrar enfermedades o medicación" }).click()
  await expect(page.getByRole("region", { name: "Medicación vigente" })).toBeVisible()
  await shot("antecedentes-encima")
  // Sin guardar nada: se cierra el formulario y luego Antecedentes, y la atención sigue igual.
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Volver a la atención" }).click()
  await expect(page.getByRole("button", { name: "Volver a la atención" })).toHaveCount(0)
  await expect(pending).toBeVisible()

  // «Antecedentes y última atención» distingue «niega» de «no se preguntó» y dice la ASA.
  await page.getByRole("button", { name: "Antecedentes y última atención" }).click()
  await expect(page.getByText("Niega enfermedades.")).toBeVisible()
  await expect(page.getByText("Aún no se le preguntó por su medicación.")).toBeVisible()
  await expect(page.getByText("ASA sin clasificar.")).toBeVisible()
  await shot("antecedentes-al-lado")
  const side = page.getByRole("complementary", { name: "Panel lateral" }).or(page.getByRole("dialog", { name: "Panel lateral" }))
  await side.getByRole("button", { name: "Cerrar" }).click()
  await expect(page.getByText("ASA sin clasificar.")).toHaveCount(0)

  // Al firmar, con lidocaína y sin saber su medicación ni su ASA, el cierre lo dice junto a los materiales.
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(dialog).toContainText("Anestesia con su salud por completar")
  await expect(dialog).toContainText("Se usa Lidocaína 2 % con epinefrina")
  await expect(dialog).toContainText("Falta preguntarle por sus alergias y su medicación; clasificar su riesgo anestésico (ASA)")
  // Avisa, no frena: firmar sigue disponible.
  await expect(dialog.getByRole("button", { name: "Finalizar y firmar" })).toBeEnabled()
  await shot("cierre-con-anestesia")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("cierre-con-anestesia-telefono")
  await page.setViewportSize({ width: 1440, height: 900 })
  // «Completar en Antecedentes» deja el cierre y abre Antecedentes encima, con la ASA a mano.
  await dialog.getByRole("button", { name: "Completar en Antecedentes" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Riesgo anestésico (ASA)" })).toBeVisible()
  await shot("completar-desde-el-cierre")
})
