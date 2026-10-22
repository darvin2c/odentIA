import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { encodeDemoCtSlice } from "@odentia/clinical"
import { type CbctDentition, generateCbctPhantom } from "@odentia/dental"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Tomografía (issue 34, ADR 0055 y 0056): la carpeta de un CD se sube desde
 * Imágenes directo al almacenamiento, la API la da por completa y el visor la
 * abre en «Panorámica y cortes» con el arco propuesto.
 */

/** Una carpeta de CD: los cortes del fantoma (no es de un paciente) y su visor. */
function writeCd(dir: string, patientName: string, dentition: CbctDentition = "permanent"): number {
  const phantom = generateCbctPhantom({ size: 128, slices: 100, voxelMm: 0.6, dentition })
  // Otro estudio, otros UID.
  const uid = dentition === "primary" ? "2.25.34778" : "2.25.34777"
  mkdirSync(path.join(dir, "DICOM"), { recursive: true })
  mkdirSync(path.join(dir, "Viewer"), { recursive: true })
  phantom.data.forEach((pixels, k) => {
    const bytes = encodeDemoCtSlice({
      width: phantom.size,
      height: phantom.size,
      pixels,
      voxelMm: phantom.voxelMm,
      position: [phantom.origin[0], phantom.origin[1], phantom.sliceZ[k]!],
      instanceNumber: k + 1,
      studyUid: uid,
      seriesUid: `${uid}.2`,
      frameOfReferenceUid: `${uid}.3`,
      sopUid: `${uid}.4.${k + 1}`,
      patientName,
      institution: "Centro de Imágenes San Borja",
    })
    writeFileSync(path.join(dir, "DICOM", `IMG${String(k).padStart(4, "0")}`), bytes)
  })
  writeFileSync(path.join(dir, "Viewer", "visor.exe"), Buffer.alloc(2048, 7))
  return phantom.slices
}

test("tomografía: la carpeta del CD se sube, queda en la ficha y se abre en panorámica y cortes", async ({ owner }) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName: "Carmen Díaz Rojas", docType: "DNI", docNumber: "41234567" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const cd = test.info().outputPath("cd")
  // El archivo trae otro nombre: el aviso pide confirmar y no cambia la ficha.
  const slices = writeCd(cd, "QUISPE^ROSA")

  await gotoHydrated(page, tenant(slug, `/patients/${patient.id}?tab=documentos&tipo=imagenes`))
  // «Nuevo ▾» es el menú de la sección; otro botón también empieza con «Nuevo».
  await page.getByRole("button", { name: /^Nuevo/ }).and(page.locator("[aria-haspopup=menu]")).click()
  await page.getByRole("menuitem", { name: "Imagen o archivo" }).click()
  const upload = surface(page, { name: "Subir imágenes o documentos" })
  await expect(upload).toBeVisible()
  await upload.getByLabel("Carpeta").setInputFiles(cd)

  const found = surface(page, { name: "Subir a la ficha" })
  await expect(found.getByRole("heading", { name: "Encontramos una tomografía" })).toBeVisible()
  await expect(found.getByText(`${slices}`, { exact: false }).first()).toBeVisible()
  await expect(found.getByText("El archivo dice «QUISPE^ROSA»")).toBeVisible()
  await expect(found.getByText(/No se suben 1 archivo/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("tomografia-encontrada.png") })
  await found.getByRole("button", { name: /Sí, es de Carmen/ }).click()

  await expect(found.getByRole("heading", { name: "La tomografía quedó en la ficha" })).toBeVisible({ timeout: 90_000 })
  await found.getByRole("button", { name: "Cerrar" }).first().click()

  // La ficha tiene una sola tomografía con todos sus archivos.
  const docs = await call<Array<{ id: string; imageType: string; imaging: { fileCount: number; uploadedCount: number; completedAt: string | null } | null }>>(
    page,
    "GET",
    `/api/patients/${patient.id}/documents`,
    slug,
  )
  const study = docs.find((doc) => doc.imageType === "tomografia")
  expect(study?.imaging).toMatchObject({ fileCount: slices, uploadedCount: slices })
  expect(study?.imaging?.completedAt).not.toBeNull()

  // Abrir: el visor arma el volumen y propone el arco.
  await page.reload()
  await page.getByRole("button", { name: /Ver Tomografía/ }).click()
  const viewer = page.getByRole("dialog", { name: /Tomografía/ })
  await expect(viewer.getByRole("tab", { name: "Panorámica y cortes" })).toBeVisible({ timeout: 60_000 })
  await expect(viewer.getByText("Panorámica reconstruida")).toBeVisible()
  await expect(viewer.getByText(/Corte \d+ de \d+/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("tomografia-visor.png") })
  await viewer.getByRole("tab", { name: "Tres cortes" }).click()
  await expect(viewer.getByText("De frente")).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("tomografia-tres-cortes.png") })
})

test("tomografía de un niño: «Ir a la pieza» lleva a la 55 en la dentición de leche", async ({ owner }) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName: "Mateo Díaz Rojas", docType: "DNI", docNumber: "81234567" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const cd = test.info().outputPath("cd-nino")
  writeCd(cd, "ROJAS^LUCAS", "primary")

  await gotoHydrated(page, tenant(slug, `/patients/${patient.id}?tab=documentos&tipo=imagenes`))
  await page.getByRole("button", { name: /^Nuevo/ }).and(page.locator("[aria-haspopup=menu]")).click()
  await page.getByRole("menuitem", { name: "Imagen o archivo" }).click()
  await surface(page, { name: "Subir imágenes o documentos" }).getByLabel("Carpeta").setInputFiles(cd)

  // La pieza se escribe con su número FDI, como en cualquier selector de piezas.
  const found = surface(page, { name: "Subir a la ficha" })
  await expect(found.getByRole("heading", { name: "Encontramos una tomografía" })).toBeVisible()
  await found.getByLabel("Escribir pieza FDI").fill("55")
  await found.getByRole("button", { name: "Agregar" }).click()
  await found.getByRole("button", { name: /Sí, es de Mateo/ }).click()
  await expect(found.getByRole("heading", { name: "La tomografía quedó en la ficha" })).toBeVisible({ timeout: 90_000 })
  await found.getByRole("button", { name: "Cerrar" }).first().click()

  await page.reload()
  await page.getByRole("button", { name: /Ver Tomografía/ }).click()
  const viewer = page.getByRole("dialog", { name: /Tomografía/ })
  await expect(viewer.getByText("Panorámica reconstruida")).toBeVisible({ timeout: 60_000 })
  // El visor encuentra el arco del niño y el corte cae en la 55, no en una permanente.
  await viewer.getByRole("button", { name: "55", exact: true }).click()
  await expect(viewer.getByText(/Corte \d+ de \d+ · pieza 55/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("tomografia-nino-55.png") })
})
