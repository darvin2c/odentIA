import { randomUUID } from "node:crypto"
import { drawSignature } from "./draw-signature"
import { API, tenant } from "./env"
import { api, call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { readPdfLikeACamera } from "./read-pdf"

const PROFILE = "/api/clinical-forms/professionals/me/profile"
const COLEGIATURA = {
  professionalTitle: "Cirujano dentista",
  registrationBody: "COP",
  registrationNumber: "12345",
}

/** Una atención lista para cerrar, con su colegiatura ya registrada. */
async function readyEncounter({ page, org }: OwnerFixture) {
  await call(page, "PUT", PROFILE, org.slug, COLEGIATURA)
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
  return { patientId: patient.id, encounterId: encounter.id }
}

/** La receta como PDF, tal como la descarga la clínica. */
async function prescriptionPdf({ page, org }: OwnerFixture, patientId: string, prescriptionId: string) {
  return page.evaluate(
    async ({ base, slug, patientId, prescriptionId }) => {
      const response = await fetch(
        `${base}/api/patients/${patientId}/health-document-pdf?documentType=prescription&documentId=${prescriptionId}`,
        { headers: { "x-odentia-org": slug }, credentials: "include" },
      )
      const bytes = new Uint8Array(await response.arrayBuffer())
      let text = ""
      for (const byte of bytes) text += String.fromCharCode(byte)
      return { status: response.status, size: bytes.length, base64: btoa(text) }
    },
    { base: API, slug: org.slug, patientId, prescriptionId },
  )
}

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

test("la firma del profesional: se dibuja al cerrar, sale en el papel y lo emitido no cambia", async ({ owner, browser }, info) => {
  const { page, org } = owner
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true })
  const { patientId, encounterId } = await readyEncounter(owner)
  const emit = () =>
    call<{ id: string }>(page, "POST", `/api/patients/${patientId}/prescriptions`, org.slug, {
      notes: null,
      items: [MEDICATION],
    }, 201)

  await gotoHydrated(page, tenant(org.slug, `/patients/${patientId}/encounters/${encounterId}`))
  const before = await emit()

  // El cierre avisa, no traba: se puede firmar sin ella, y lleva a dibujarla.
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const closing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(closing.getByText("tus papeles salen con una línea para firmar a mano")).toBeVisible()
  await shot("cierre-sin-firma")
  await closing.getByRole("button", { name: "Agregar mi firma", exact: true }).click()

  const drawer = page.getByRole("dialog", { name: "Perfil profesional" })
  await expect(drawer.getByText("Tu firma", { exact: true })).toBeVisible()
  const pad = drawer.getByRole("img", { name: "Dibuja tu firma" })
  // Vino a poner su firma: el recuadro se ve sin buscarlo.
  await expect(pad).toBeInViewport()
  await drawSignature(page, pad)
  await shot("firma-dibujada")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(pad).toBeVisible()
  await shot("firma-dibujada-movil")
  await page.setViewportSize({ width: 1280, height: 720 })

  const saved = page.waitForResponse((response) => response.url().endsWith(PROFILE) && response.request().method() === "PUT")
  await drawer.getByRole("button", { name: "Guardar perfil", exact: true }).click()
  expect((await saved).status()).toBe(200)
  await expect(drawer).toBeHidden()

  const mine = await call<{ signatureStrokes: number[][][] | null }>(page, "GET", PROFILE, org.slug)
  expect(mine.signatureStrokes?.[0]?.length).toBeGreaterThan(5)

  // Ya guardada, el cierre ofrece cambiarla y el perfil la muestra.
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(closing.getByText("Tus papeles llevan la firma que guardaste.")).toBeVisible()
  await closing.getByRole("button", { name: "Cambiar mi firma", exact: true }).click()
  // Va primero: quien vino a cambiarla no la busca debajo de los demás datos.
  const shown = drawer.getByRole("img", { name: "Tu firma guardada" })
  await expect(shown).toBeInViewport()
  await shot("firma-guardada")

  // Lo emitido antes no la lleva; lo nuevo sí.
  const after = await emit()
  const old = await prescriptionPdf(owner, patientId, before.id)
  const fresh = await prescriptionPdf(owner, patientId, after.id)
  expect(old.status).toBe(200)
  expect(fresh.status).toBe(200)
  const drawings = async (pdf: { base64: string }) =>
    (await readPdfLikeACamera(browser, Buffer.from(pdf.base64, "base64"))).drawings
  expect(await drawings(fresh)).toBeGreaterThan(await drawings(old))
  await info.attach("receta-con-firma.pdf.b64", { body: fresh.base64 })
  await info.attach("receta-sin-firma.pdf.b64", { body: old.base64 })

  // Quitar dice la consecuencia y se puede deshacer antes de guardar.
  await drawer.getByRole("button", { name: "Quitar", exact: true }).click()
  await expect(drawer.getByText("tus papeles saldrán con una línea para firmar a mano")).toBeVisible()
  await drawer.getByRole("button", { name: "Deshacer", exact: true }).click()
  await expect(shown).toBeVisible()
  await drawer.getByRole("button", { name: "Quitar", exact: true }).click()
  await drawer.getByRole("button", { name: "Guardar perfil", exact: true }).click()
  await expect(drawer).toBeHidden()
  expect((await call<{ signatureStrokes: unknown }>(page, "GET", PROFILE, org.slug)).signatureStrokes).toBeNull()
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(closing.getByRole("button", { name: "Agregar mi firma", exact: true })).toBeVisible()

  // Lo que se emitió con ella la conserva aunque ya no la tenga.
  const kept = await prescriptionPdf(owner, patientId, after.id)
  expect(kept.base64).toBe(fresh.base64)
})

test("la hoja del odontograma firmado lleva la firma que regía, o la línea para firmar a mano", async ({ owner, browser }, info) => {
  const { page, org, user } = owner
  const { patientId } = await readyEncounter(owner)
  const sign = () =>
    call<{ id: string }>(page, "POST", `/api/patients/${patientId}/odontogram/assessments`, org.slug, {
      purpose: "personal",
      specifications: "A pedido de la persona.",
      observations: "Sin observaciones.",
    }, 201)
  const sheet = (id: string) => tenant(org.slug, `/patients/${patientId}/odontogram/${id}/print`)

  const without = await sign()
  await call(page, "PUT", PROFILE, org.slug, {
    ...COLEGIATURA,
    signatureStrokes: [[[60, 500], [200, 150], [320, 800], [480, 200], [640, 700], [820, 350]]],
  })
  const withIt = await sign()

  await gotoHydrated(page, sheet(withIt.id))
  const trace = page.getByRole("img", { name: `Firma de ${user.name}` })
  await expect(trace).toBeVisible()
  await expect(page.getByText(/^Firmado electrónicamente/)).toBeVisible()
  await page.screenshot({ path: info.outputPath("odontograma-con-firma.png"), fullPage: true })
  // Impresa cabe en una hoja, y su QR se lee en esa hoja y abre la comprobación.
  await expect(page.getByRole("img", { name: "Código para comprobar este documento" })).toBeVisible()
  const printed = await readPdfLikeACamera(browser, await page.pdf({ preferCSSPageSize: true }), {
    picturePath: info.outputPath("odontograma-impreso.png"),
  })
  expect(printed.pages).toBe(1)
  const scanned = printed.qr
  expect(scanned).toContain(`${tenant(org.slug, "")}/comprobar/`)
  const stranger = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  const check = await stranger.newPage()
  await gotoHydrated(check, scanned as string)
  await expect(check.getByRole("heading", { name: "Documento vigente", exact: true })).toBeVisible()
  // Se imprime desde el navegador: no hay archivo con el que comparar.
  await expect(check.getByRole("button", { name: "Elegir el PDF", exact: true })).toHaveCount(0)
  await stranger.close()

  await gotoHydrated(page, sheet(without.id))
  await expect(page.getByText(/^Firmado electrónicamente/)).toBeVisible()
  await expect(trace).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("odontograma-sin-firma.png"), fullPage: true })

  // Lo firmado conserva el documento que la persona tenía, aunque después lo corrijan.
  await call(page, "PATCH", `/api/patients/${patientId}`, org.slug, { docType: "DNI", docNumber: "99887766" })
  await gotoHydrated(page, sheet(withIt.id))
  await expect(page.getByText("DNI: 41223344", { exact: true })).toBeVisible()
  await expect(page.getByText("99887766")).toHaveCount(0)

  // El color de la marca va en la línea del membrete, y se congela al firmar: la hoja firmada
  // antes de elegirlo sigue en gris; la firmada después lo lleva (ADR 0162).
  const line = () => page.locator(".odontogram-sheet header").first().evaluate((el) => getComputedStyle(el).borderBottomColor)
  const gray = await line()
  await call(page, "PUT", "/api/org-profile/brand-color", org.slug, { color: "#ea580c" })
  await gotoHydrated(page, sheet(withIt.id))
  await expect(page.getByText(/^Firmado electrónicamente/)).toBeVisible()
  expect(await line()).toBe(gray)
  const colored = await sign()
  await gotoHydrated(page, sheet(colored.id))
  await expect(page.getByText(/^Firmado electrónicamente/)).toBeVisible()
  expect(await line()).not.toBe(gray)
  expect(await line()).not.toBe("rgb(234, 88, 12)")
})

test("el servidor rechaza una firma mal formada y no entrega las firmas en la lista del equipo", async ({ owner }) => {
  const { page, org, user } = owner
  await call(page, "PUT", PROFILE, org.slug, {
    ...COLEGIATURA,
    signatureStrokes: [[[10, 10], [200, 120]]],
  })

  const invalid = await api<{ error: { fields?: Record<string, string> } }>(page, "PUT", PROFILE, org.slug, {
    ...COLEGIATURA,
    signatureStrokes: [[[10, 10]]],
  })
  expect(invalid.status).toBe(400)
  expect(invalid.body.error.fields?.signatureStrokes).toBeTruthy()

  // La lista del equipo no lleva firmas de nadie.
  const team = await call<Array<{ userId: string; signatureStrokes?: unknown }>>(
    page,
    "GET",
    "/api/clinical-forms/professionals/profiles",
    org.slug,
  )
  expect(team.find((row) => row.userId === user.id)).toBeTruthy()
  expect(team.every((row) => row.signatureStrokes === undefined)).toBe(true)

  // Los datos de un papel tampoco: la hoja es el PDF.
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: randomUUID(),
    answers: { demographics: { displayName: "Rosa Mamani" }, respondent: "staff", privacyAccepted: false },
  }, 201)
  const rx = await call<{ id: string }>(page, "POST", `/api/patients/${patient.id}/prescriptions`, org.slug, {
    notes: null,
    items: [MEDICATION],
  }, 201)
  const print = await call<Record<string, unknown>>(
    page,
    "GET",
    `/api/patients/${patient.id}/prescriptions/${rx.id}/print`,
    org.slug,
  )
  expect(print.prescription).toBeTruthy()
  expect(print.signerStrokes).toBeUndefined()
})
