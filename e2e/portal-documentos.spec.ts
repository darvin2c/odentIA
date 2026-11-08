import { randomUUID } from "node:crypto"
import { call, expect, test } from "./fixtures"

/**
 * El portal muestra todo lo suyo, sin elegir (ADR 0152): recepción da el
 * acceso sin «Qué verá» y la persona ve sus recetas en «Tus documentos», la
 * anulada marcada como «Anulada» y en palabras, sin códigos. La fila no se sale
 * de la tarjeta a 390 px.
 */
const MEDICATION = {
  genericName: "ibuprofeno",
  strength: "400 mg",
  dosageForm: "tableta",
  dose: "1 tableta",
  route: "oral",
  frequency: "Cada 8 horas",
  duration: "3 días",
  quantity: null,
  instructions: null,
}

test("el portal muestra sus recetas sin que nadie las elija, la anulada marcada", async ({ owner, browser }) => {
  const { page, org } = owner
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, {
    professionalTitle: "Cirujano dentista",
    registrationBody: "COP",
    registrationNumber: "12345",
  })
  const patient = await call<{ id: string }>(
    page,
    "POST",
    "/api/patients",
    org.slug,
    {
      submissionId: randomUUID(),
      answers: {
        demographics: {
          displayName: "Rosa Mamani",
          docType: "DNI",
          docNumber: "41223344",
          birthDate: "1980-05-05",
        },
        respondent: "staff",
        privacyAccepted: false,
      },
    },
    201,
  )
  const valid = await call<{ id: string; prescriptionNumber: number }>(
    page,
    "POST",
    `/api/patients/${patient.id}/prescriptions`,
    org.slug,
    { notes: null, items: [MEDICATION] },
    201,
  )
  const voided = await call<{ id: string; prescriptionNumber: number }>(
    page,
    "POST",
    `/api/patients/${patient.id}/prescriptions`,
    org.slug,
    { notes: null, items: [{ ...MEDICATION, genericName: "paracetamol", strength: "500 mg" }] },
    201,
  )
  await call(page, "POST", `/api/patients/${patient.id}/prescriptions/${voided.id}/cancel`, org.slug, {
    reason: "Dosis equivocada",
  })

  // La clínica tiene el portal encendido en Configuración.
  await call(page, "PUT", "/api/portal/policy", org.slug, {
    enabled: true,
    allowedScope: { appointments: true, budgets: true, account: true, documents: true },
  })

  // Dar acceso: quién entra, la comprobación y cómo le llega. No se elige qué verá.
  const summary = await call<{ candidates: Array<{ contactId: string; document: string | null }> }>(
    page,
    "GET",
    `/api/portal/access?patientId=${patient.id}`,
    org.slug,
  )
  const person = summary.candidates[0]
  expect(person?.document).toBe("DNI 41223344")
  const given = await call<{ activationUrlOnce: string; pinOnce: string }>(
    page,
    "POST",
    "/api/portal/access",
    org.slug,
    { patientId: patient.id, contactId: person!.contactId, identityChecked: true, delivery: "qr" },
    201,
  )

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const portal = await phone.newPage()
  await portal.goto(given.activationUrlOnce)
  await portal.getByLabel("Código").fill(given.pinOnce)
  await portal.getByRole("button", { name: "Entrar" }).click()
  const later = portal.getByRole("button", { name: "Ahora no" })
  if (await later.isVisible().catch(() => false)) await later.first().click()

  const documents = portal.getByRole("region", { name: "Tus documentos" })
  await expect(documents.getByText(`Receta N.º ${valid.prescriptionNumber}`)).toBeVisible()
  const voidedRow = documents.getByRole("button", { name: new RegExp(`Receta N\\.º ${voided.prescriptionNumber}`) })
  await expect(voidedRow).toContainText("Anulada")
  // En palabras: nunca el código interno de un tipo.
  await expect(documents).not.toContainText("foto_clinica")
  // La fila no se sale de la tarjeta en el teléfono.
  const card = await documents.boundingBox()
  const row = await voidedRow.boundingBox()
  expect(card && row && row.x + row.width <= card.x + card.width + 1).toBe(true)
  await phone.close()
})
