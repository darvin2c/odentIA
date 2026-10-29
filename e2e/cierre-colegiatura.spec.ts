import { randomUUID } from "node:crypto"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Sin colegiatura no se firma (ADR 0003), pero no hay que salir de la
 * atención: el cierre la pide en el mismo diálogo, la guarda en el perfil
 * profesional y firma. El colegio viene propuesto por el producto (COP en
 * odentIA); con el número vacío, el aviso queda junto al campo.
 */
test("odentIA: sin colegiatura, el cierre la pide, la guarda y firma", async ({ owner }) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Rosa Mamani", docType: "DNI", docNumber: "41223344" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `/api/patients/${patient.id}/encounters`, org.slug, {
    reason: "Dolor en una muela",
  }, 201)
  const path = `/api/patients/${patient.id}/encounters/${encounter.id}`
  await call(page, "POST", `${path}/diagnoses`, org.slug, { diagnosisCode: "K02.1", diagnosisType: "provisional" }, 201)
  await call(page, "PATCH", path, org.slug, { evolution: "Caries de la dentina en la 36; se indica resina." })

  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await expect(page.getByText("Listo para firmar · falta tu colegiatura, se pide al firmar")).toBeVisible()
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const firma = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(firma.getByText("Falta tu colegiatura para firmar")).toBeVisible()
  await expect(firma.getByLabel("Colegio")).toHaveValue("COP")
  // El dueño de la clínica de prueba no tiene título: se propone el del país.
  await expect(firma.getByLabel("Título profesional")).toHaveValue("Cirujano dentista")
  // Lo que falta escribir es el número: ahí empieza el foco.
  await expect(firma.getByLabel("Número de colegiatura")).toBeFocused()
  await page.screenshot({ path: test.info().outputPath("cierre-pide-colegiatura.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(firma.getByRole("button", { name: "Guardar y firmar", exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath("cierre-pide-colegiatura-movil.png"), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })

  // Sin número no se guarda nada: el aviso queda junto al campo y el cierre sigue abierto.
  await firma.getByRole("button", { name: "Guardar y firmar", exact: true }).click()
  await expect(firma.getByText("Escribe tu número de colegiatura")).toBeVisible()
  await firma.getByLabel("Número de colegiatura").fill("12345")
  await expect(firma.getByText("Escribe tu número de colegiatura")).toHaveCount(0)
  await firma.getByRole("button", { name: "Guardar y firmar", exact: true }).click()

  await expect(page.getByRole("dialog", { name: "Atención finalizada" })).toBeVisible()
  const profile = await call<{ professionalTitle: string; registrationBody: string; registrationNumber: string }>(
    page,
    "GET",
    "/api/clinical-forms/professionals/me/profile",
    org.slug,
  )
  expect(profile).toMatchObject({
    professionalTitle: "Cirujano dentista",
    registrationBody: "COP",
    registrationNumber: "12345",
  })
  const closed = await call<{ encounter: { status: string } }>(page, "GET", path, org.slug)
  expect(closed.encounter.status).toBe("finalizada")
})
