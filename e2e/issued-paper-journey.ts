import { writeFile } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import type { Browser, Page } from "@playwright/test"
import { expect } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { readPdfLikeACamera } from "./read-pdf"

/** El PDF de un papel, tal como lo descarga la clínica. */
export async function downloadPaper(
  page: Page,
  input: { api: string; slug: string; patientId: string; type: string; id: string },
): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ api, slug, patientId, type, id }) => {
    const response = await fetch(
      `${api}/api/patients/${patientId}/health-document-pdf?documentType=${type}&documentId=${id}`,
      { headers: { "x-odentia-org": slug }, credentials: "include" },
    )
    if (!response.ok) throw new Error(`PDF ${type}: ${response.status}`)
    let text = ""
    for (const byte of new Uint8Array(await response.arrayBuffer()))
      text += String.fromCharCode(byte)
    return btoa(text)
  }, input)
  return Buffer.from(base64, "base64")
}

/**
 * Lo que hace quien recibe el papel: escanea su QR con la cámara, abre la página sin
 * cuenta y compara el archivo. Un PDF con un solo byte de más ya no es el original.
 */
export async function scanAndCompare(
  browser: Browser,
  pdf: Buffer,
  input: {
    origin: string
    state: string
    /** Las iniciales que dice el papel: las mismas aunque hoy se llame distinto. */
    initials: string
    picturePath: string
    pagePicturePath: string
  },
): Promise<string> {
  const { qr } = await readPdfLikeACamera(browser, pdf, { picturePath: input.picturePath })
  // Si no se lee, queda el archivo para mirarlo.
  if (!qr) await writeFile(`${input.picturePath}.pdf`, pdf)
  expect(qr, "El QR del PDF se lee con la cámara").toBeTruthy()
  expect(qr).toContain(`${input.origin}/comprobar/`)

  const stranger = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  })
  try {
    const page = await stranger.newPage()
    await gotoHydrated(page, qr as string)
    await expect(page.getByRole("heading", { name: input.state, exact: true })).toBeVisible()
    await expect(page.getByText(input.initials, { exact: true })).toBeVisible()
    await compareFile(page, pdf, "Es el original.")
    await page.screenshot({ path: input.pagePicturePath, fullPage: true })
    await compareFile(page, Buffer.concat([pdf, Buffer.from(" ")]), "No coincide con el original.")
    // Lo que no debe salir: nada de lo que dice el papel.
    expect(await page.locator("main").innerText()).not.toMatch(/ibuprofeno|tableta|Motivo/i)
    // Se puede usar con lectores de pantalla y sin mouse.
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
    expect(
      audit.violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
    ).toEqual([])
  } finally {
    await stranger.close()
  }
  return qr as string
}

/** Con el teclado, como lo haría quien no usa mouse: el botón abre el selector de archivos. */
async function compareFile(page: Page, file: Buffer, expected: string) {
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: /^(Elegir el PDF|Comprobar otro archivo)$/ }).focus()
  await page.keyboard.press("Enter")
  await (await chooser).setFiles({
    name: "documento.pdf",
    mimeType: "application/pdf",
    buffer: file,
  })
  await expect(page.getByText(expected, { exact: true })).toBeVisible()
}
