import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { encodeDemoCtSlice, generateCbctPhantom } from "@odentia/clinical"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Tomografía (issue 34, ADR 0054 y 0055): la carpeta de un CD se sube desde
 * Imágenes directo al almacenamiento, la API la da por completa y el visor la
 * abre en «Panorámica y cortes» con el arco propuesto.
 */

/** Una carpeta de CD: los cortes del fantoma (no es de un paciente) y su visor. */
function writeCd(dir: string, patientName: string): number {
  const phantom = generateCbctPhantom({ size: 128, slices: 100, voxelMm: 0.6 })
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
      studyUid: "2.25.34777",
      seriesUid: "2.25.34777.2",
      frameOfReferenceUid: "2.25.34777.3",
      sopUid: `2.25.34777.4.${k + 1}`,
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
  await page.getByRole("button", { name: /^Nuevo/ }).click()
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
