import { randomUUID } from "node:crypto"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Sin colegiatura en el perfil la atención se firma igual (17 nov): el cierre
 * la pide en el mismo diálogo y, si se escribe, la guarda en el perfil; si no,
 * pide escribir por qué se firma sin ella. El colegio viene propuesto por el
 * producto (COP en odentIA). No es una falta del pie.
 */
async function draftWithoutRegistration(page: Parameters<typeof call>[0], slug: string) {
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Rosa Mamani", docType: "DNI", docNumber: `4${Math.floor(Math.random() * 9_000_000 + 1_000_000)}` },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `/api/patients/${patient.id}/encounters`, slug, {
    reason: "Dolor en una muela",
  }, 201)
  const path = `/api/patients/${patient.id}/encounters/${encounter.id}`
  await call(page, "POST", `${path}/diagnoses`, slug, { diagnosisCode: "K02.1", diagnosisType: "provisional" }, 201)
  await call(page, "PATCH", path, slug, { evolution: "Caries de la dentina en la 36; se indica resina." })
  return { path, url: tenant(slug, `/patients/${patient.id}/encounters/${encounter.id}`) }
}

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
  // La colegiatura no es una falta del pie: no traba la atención (17 nov).
  await expect(page.getByText("Listo para firmar")).toBeVisible()
  await expect(page.getByText(/Falta 1: tu colegiatura/)).toHaveCount(0)
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const firma = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(firma.getByText("No tienes tu colegiatura en el perfil")).toBeVisible()
  await expect(firma.getByLabel("Colegio")).toHaveValue("COP")
  // El dueño de la clínica de prueba no tiene título: se propone el del país.
  await expect(firma.getByLabel("Título profesional")).toHaveValue("Cirujano dentista")
  // Hay dos salidas (escribirla o firmar sin ella con el motivo): el foco no elige por la persona.
  await expect(firma.getByLabel("Número de colegiatura")).not.toBeFocused()
  await expect(firma.getByLabel("Si firmas sin colegiatura, escribe por qué")).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("cierre-pide-colegiatura.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(firma.getByRole("button", { name: "Finalizar y firmar", exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath("cierre-pide-colegiatura-movil.png"), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })

  // Sin número ni motivo no se firma: el aviso dice las dos salidas y el cierre sigue abierto.
  await firma.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(firma.getByText("Escribe tu colegiatura, o por qué firmas sin ella")).toBeVisible()
  await firma.getByLabel("Número de colegiatura").pressSequentially("12345")
  await firma.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()

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

test("odentIA: sin colegiatura se firma escribiendo por qué, y el motivo queda en la atención", async ({ owner }) => {
  const { page, org } = owner
  const draft = await draftWithoutRegistration(page, org.slug)
  await gotoHydrated(page, draft.url)
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const firma = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await firma.getByLabel("Si firmas sin colegiatura, escribe por qué").pressSequentially("Colegiatura en trámite")
  await firma.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Atención finalizada" })).toBeVisible()
  const closed = await call<{ encounter: { status: string; signerRegistration: string | null; registrationSkipReason: string | null } }>(
    page,
    "GET",
    draft.path,
    org.slug,
  )
  expect(closed.encounter).toMatchObject({
    status: "finalizada",
    signerRegistration: null,
    registrationSkipReason: "Colegiatura en trámite",
  })
  // El perfil sigue sin colegiatura: no se inventó una.
  const profile = await call<{ registrationNumber: string | null }>(page, "GET", "/api/clinical-forms/professionals/me/profile", org.slug)
  expect(profile.registrationNumber ?? "").toBe("")
})
