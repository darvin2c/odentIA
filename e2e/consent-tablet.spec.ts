import { randomUUID } from "node:crypto"
import { drawSignature } from "./draw-signature"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Firmar en la tablet de la clínica: la persona lee la misma hoja que el papel
 * (membrete, sus datos, la pieza, la declaración) y firma donde va su firma; el
 * profesional confirma al final con su perfil. Sin firmar, no se avanza.
 */
test("firma en la tablet: lee la hoja del papel, firma donde va su firma y el profesional confirma", async ({
  owner,
}, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 820, height: 1180 })
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
          givenNames: "Rosa",
          familyName: "Mamani",
          birthDate: "1980-03-02",
          docType: "DNI",
          docNumber: "41223355",
        },
        respondent: "staff",
        privacyAccepted: false,
      },
    },
    201,
  )
  const templates = await call<{ id: string; key: string; title: string; status: string }[]>(
    page,
    "GET",
    "/api/clinical-forms/consent-templates",
    org.slug,
  )
  const template = templates.find((row) => row.key === "exodoncia" && row.status === "publicado")
  if (!template) throw new Error("Falta la plantilla de exodoncia")
  await call(
    page,
    "POST",
    "/api/clinical-forms/consents",
    org.slug,
    {
      templateId: template.id,
      patientId: patient.id,
      procedureRef: "Exodoncia pieza 38",
    },
    201,
  )

  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}?tab=documentos`))
  const paper = `Consentimiento · ${template.title}`
  await page
    .getByRole("button", { name: new RegExp(paper) })
    .first()
    .click()
  await surface(page, { name: paper }).getByRole("button", { name: "Firmar ahora" }).click()

  const screen = page.getByRole("dialog", { name: "Firma de Rosa" })
  const sheet = screen.getByRole("article", { name: template.title })
  await expect(sheet.getByText("Consentimiento informado")).toBeVisible()
  await page.screenshot({ path: info.outputPath("0-hoja-tablet-arriba.png") })
  await expect(sheet.getByText("Exodoncia pieza 38", { exact: true })).toBeVisible()
  await expect(sheet.getByText("41223355", { exact: true })).toBeVisible()
  await expect(sheet.getByRole("heading", { name: "Riesgos y molestias" })).toBeVisible()
  await expect(sheet.getByText(/^He leído y comprendido la información/)).toBeVisible()
  await expect(sheet.getByRole("heading", { name: "Paciente", exact: true })).toBeVisible()
  // Lo del profesional se dice pendiente, y el nivel de firma va al pie de la hoja.
  await expect(sheet.getByText("Falta su confirmación: lo confirma al terminar.")).toBeVisible()
  await expect(sheet.getByText("Firma simple · en la clínica")).toBeVisible()
  await sheet.getByRole("img", { name: "Firma de Rosa Mamani" }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath("1-hoja-tablet-firma.png") })

  // Sin la casilla ni la firma no avanza, y lo dice en su lugar.
  await screen.getByRole("button", { name: "Listo" }).click()
  await expect(sheet.getByText("Marca la casilla para seguir")).toBeVisible()
  await expect(sheet.getByText("Falta la firma de Rosa")).toBeVisible()

  await sheet.getByRole("checkbox", { name: "Entendí lo que me explicaron y acepto" }).click()
  await page.screenshot({ path: info.outputPath("2-hoja-tablet-avisos.png") })
  await drawSignature(page, sheet.getByRole("img", { name: "Firma de Rosa Mamani" }))
  await screen.getByRole("button", { name: "Listo" }).click()
  const confirming = page.getByRole("dialog", { name: "Confirma que informaste" })
  await expect(confirming.getByText("Informé a Rosa y resolví sus dudas.")).toBeVisible()
  await confirming.getByRole("button", { name: "Confirmar" }).click()
  await expect(page.getByText("Consentimiento firmado")).toBeVisible()
})

test("firma en la tablet de una menor: firma su representante legal y la hoja trae el diagnóstico, como el papel", async ({
  owner,
}, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 820, height: 1180 })
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, {
    professionalTitle: "Cirujano dentista",
    registrationBody: "COP",
    registrationNumber: "12345",
  })
  const mother = await call<{ id: string }>(page, "POST", "/api/contacts", org.slug, { displayName: "Marta Quispe" }, 201)
  const child = await call<{ id: string }>(
    page,
    "POST",
    "/api/patients",
    org.slug,
    {
      submissionId: randomUUID(),
      answers: {
        demographics: { displayName: "Lucía Quispe", birthDate: "2018-05-10", docType: "DNI", docNumber: "87654322" },
        respondent: "staff",
        // Una menor se registra con su representante legal: queda vigente desde hoy.
        representative: {
          displayName: "Marta Quispe",
          relationship: "guardian",
          relationshipDetail: "Madre",
          phone: "+447700900123",
          docType: "DNI",
          docNumber: "41529978",
        },
        privacyAccepted: false,
      },
      contacts: [{ contactId: mother.id, relationship: "guardian", relationshipDetail: "Madre", isPreferred: true }],
    },
    201,
  )
  const templates = await call<{ id: string; key: string; title: string; status: string }[]>(
    page,
    "GET",
    "/api/clinical-forms/consent-templates",
    org.slug,
  )
  const template = templates.find((row) => row.key === "exodoncia" && row.status === "publicado")
  if (!template) throw new Error("Falta la plantilla de exodoncia")
  await call(
    page,
    "POST",
    "/api/clinical-forms/consents",
    org.slug,
    { templateId: template.id, patientId: child.id, procedureRef: "Exodoncia pieza 75", diagnosisCode: "K02.1" },
    201,
  )

  await gotoHydrated(page, tenant(org.slug, `/patients/${child.id}?tab=documentos`))
  const paper = `Consentimiento · ${template.title}`
  await page
    .getByRole("button", { name: new RegExp(paper) })
    .first()
    .click()
  await surface(page, { name: paper }).getByRole("button", { name: "Firmar ahora" }).click()

  // Firma la madre: la hoja lo dice como el papel, con el aviso de menor y el diagnóstico.
  const screen = page.getByRole("dialog", { name: "Firma de Marta" })
  const sheet = screen.getByRole("article", { name: template.title })
  await expect(sheet.getByRole("heading", { name: "Diagnóstico que lo motiva" })).toBeVisible()
  await expect(sheet.getByText(/K02\.1/)).toBeVisible()
  await expect(sheet.getByText("Firma su representante legal.", { exact: false })).toBeVisible()
  await expect(sheet.getByRole("heading", { name: "Representante legal" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("3-menor-arriba.png") })
  await sheet.getByRole("img", { name: "Firma de Marta Quispe" }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath("4-menor-firma.png") })
  await sheet.getByRole("checkbox", { name: "Entendí lo que me explicaron y acepto" }).click()
  await drawSignature(page, sheet.getByRole("img", { name: "Firma de Marta Quispe" }))
  await screen.getByRole("button", { name: "Listo" }).click()
  const confirming = page.getByRole("dialog", { name: "Confirma que informaste" })
  await confirming.getByRole("button", { name: "Confirmar" }).click()
  await expect(page.getByText("Consentimiento firmado")).toBeVisible()
})
