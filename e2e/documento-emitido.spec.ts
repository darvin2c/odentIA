import { randomUUID } from "node:crypto"
import { API, tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { downloadPaper, scanAndCompare } from "./issued-paper-journey"
import { readPdfLikeACamera } from "./read-pdf"

const PROFILE = "/api/clinical-forms/professionals/me/profile"
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

test("lo emitido no cambia, y su QR se lee y comprueba el archivo", async ({
  owner,
  browser,
}, info) => {
  const { page, org } = owner
  await call(page, "PUT", PROFILE, org.slug, {
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
        demographics: { displayName: "Rosa Mamani", docType: "DNI", docNumber: "41223344" },
        respondent: "staff",
        privacyAccepted: false,
      },
    },
    201,
  )
  const prescription = await call<{ id: string }>(
    page,
    "POST",
    `/api/patients/${patient.id}/prescriptions`,
    org.slug,
    {
      notes: null,
      items: [MEDICATION],
    },
    201,
  )
  const paper = (type: string, id: string) =>
    downloadPaper(page, { api: API, slug: org.slug, patientId: patient.id, type, id })
  const origin = tenant(org.slug, "")

  // Recién emitida ya tiene su archivo: se abre sin haber pasado por la pantalla.
  const issued = await paper("prescription", prescription.id)
  await scanAndCompare(browser, issued, {
    origin,
    state: "Documento vigente",
    initials: "R. M.",
    picturePath: info.outputPath("receta.png"),
    pagePicturePath: info.outputPath("comprobar-vigente.png"),
  })

  // Cambian la persona y quien firma: el papel emitido sigue siendo el mismo archivo.
  await call(page, "PATCH", `/api/patients/${patient.id}`, org.slug, {
    displayName: "Rosa Quispe Cambiada",
    docType: "DNI",
    docNumber: "99887766",
  })
  const renamed = await call<{ patient: { displayName: string } }>(
    page,
    "GET",
    `/api/patients/${patient.id}`,
    org.slug,
  )
  expect(renamed.patient.displayName).toBe("Rosa Quispe Cambiada")
  await call(page, "PUT", PROFILE, org.slug, {
    professionalTitle: "Cirujano dentista",
    registrationBody: "COP",
    registrationNumber: "99999",
  })
  expect((await paper("prescription", prescription.id)).equals(issued)).toBe(true)

  // La orden y el descanso también se leen con la cámara.
  const order = await call<{ id: string }>(
    page,
    "POST",
    "/api/clinical-forms/orders",
    org.slug,
    {
      patientId: patient.id,
      kind: "laboratorio",
      recipient: "Laboratorio Central",
      title: "Hemograma completo",
    },
    201,
  )
  const orderPdf = await paper("order", order.id)
  expect(
    (await readPdfLikeACamera(browser, orderPdf, { picturePath: info.outputPath("orden.png") })).qr,
  ).toContain(`${origin}/comprobar/`)
  const leave = await call<{ id: string }>(
    page,
    "POST",
    `/api/patients/${patient.id}/medical-leaves`,
    org.slug,
    {
      startsOn: new Date().toISOString().slice(0, 10),
      days: 1,
    },
    201,
  )
  const leavePdf = await paper("medical_leave", leave.id)
  expect(
    (await readPdfLikeACamera(browser, leavePdf, { picturePath: info.outputPath("descanso.png") }))
      .qr,
  ).toContain(`${origin}/comprobar/`)

  // El consentimiento firmado también: su QR se lee y su archivo se reconoce.
  const template = await call<{ id: string }>(
    page,
    "POST",
    "/api/clinical-forms/consent-templates",
    org.slug,
    {
      key: `prueba-${randomUUID().slice(0, 8)}`,
      title: "Exodoncia",
      body: "Extracción de la pieza indicada, con anestesia local.",
    },
    201,
  )
  await call(
    page,
    "POST",
    `/api/clinical-forms/consent-templates/${template.id}/publish`,
    org.slug,
    {},
    201,
  )
  const consent = await call<{ id: string }>(
    page,
    "POST",
    "/api/clinical-forms/consents",
    org.slug,
    {
      templateId: template.id,
      patientId: patient.id,
      procedureRef: "Exodoncia de la pieza 38",
    },
    201,
  )
  const detail = await call<{ contacts: Array<{ contactId: string; relationship: string }> }>(
    page,
    "GET",
    `/api/patients/${patient.id}`,
    org.slug,
  )
  const self = detail.contacts.find((link) => link.relationship === "self")
  await call(page, "POST", `/api/clinical-forms/consents/${consent.id}/sign`, org.slug, {
    signerKind: "paciente",
    signerContactId: self?.contactId,
    comprehensionConfirmed: true,
    signatureData: {
      strokes: [
        [
          [10, 10],
          [100, 60],
          [200, 20],
        ],
      ],
    },
  })
  await scanAndCompare(browser, await paper("consent", consent.id), {
    origin,
    state: "Documento vigente",
    initials: "R. Q. C.",
    picturePath: info.outputPath("consentimiento.png"),
    pagePicturePath: info.outputPath("comprobar-consentimiento.png"),
  })

  // La hoja de atención: sale al firmar, se ve en la atención y se reconoce con su QR.
  const encounter = await call<{ id: string }>(
    page,
    "POST",
    `/api/patients/${patient.id}/encounters`,
    org.slug,
    {
      reason: "Dolor en una muela",
    },
    201,
  )
  const encounterPath = `/api/patients/${patient.id}/encounters/${encounter.id}`
  await call(
    page,
    "POST",
    `${encounterPath}/diagnoses`,
    org.slug,
    { diagnosisCode: "K02.1", diagnosisType: "provisional" },
    201,
  )
  await call(page, "PATCH", encounterPath, org.slug, {
    evolution: "Nota que no sale de la clínica.",
  })
  await call(page, "POST", `${encounterPath}/finalize`, org.slug, {})
  const sheet = await paper("attention_sheet", encounter.id)
  await scanAndCompare(browser, sheet, {
    origin,
    state: "Documento vigente",
    initials: "R. Q. C.",
    picturePath: info.outputPath("hoja-de-atencion.png"),
    pagePicturePath: info.outputPath("comprobar-hoja.png"),
  })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await page.getByRole("button", { name: "Ver hoja de atención", exact: true }).click()
  // Mientras el PDF carga es un botón desactivado; ya listo, el enlace que lo descarga.
  await expect(page.getByRole("link", { name: "Descargar PDF" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible()
  await page.screenshot({ path: info.outputPath("hoja-en-la-atencion.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: info.outputPath("hoja-en-la-atencion-movil.png") })
  await page.setViewportSize({ width: 1280, height: 720 })

  // Anulada: el sello va encima, el QR sigue leyéndose y el original se sigue reconociendo.
  await call(
    page,
    "POST",
    `/api/patients/${patient.id}/prescriptions/${prescription.id}/cancel`,
    org.slug,
    {
      reason: "Se indicó otra dosis",
    },
  )
  const voided = await paper("prescription", prescription.id)
  expect(voided.equals(issued)).toBe(false)
  await scanAndCompare(browser, issued, {
    origin,
    state: "Documento anulado",
    initials: "R. M.",
    picturePath: info.outputPath("receta-original.png"),
    pagePicturePath: info.outputPath("comprobar-anulado.png"),
  })
  expect(
    (
      await readPdfLikeACamera(browser, voided, {
        picturePath: info.outputPath("receta-anulada.png"),
      })
    ).qr,
  ).toContain(`${origin}/comprobar/`)
})
