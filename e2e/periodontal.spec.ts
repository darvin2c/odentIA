import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { patientApiPath } from "./patients-fixture"

/**
 * Periodontograma (issue 49): un periodontograma completo solo con el
 * teclado, la clasificación guiada, el cierre que lo deja fijo, su lugar en
 * la ficha (debajo de Odontograma) y la comparación de dos visitas.
 */

const UPPER = [17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27]
const LOWER = [47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37]
/** El orden fijo de la sonda: arriba por fuera, arriba por dentro, abajo por dentro, abajo por fuera. */
const SEQUENCE: Array<[number, "buccal" | "lingual"]> = [
  ...UPPER.map((tooth) => [tooth, "buccal"] as [number, "buccal"]),
  ...[...UPPER].reverse().map((tooth) => [tooth, "lingual"] as [number, "lingual"]),
  ...LOWER.map((tooth) => [tooth, "lingual"] as [number, "lingual"]),
  ...[...LOWER].reverse().map((tooth) => [tooth, "buccal"] as [number, "buccal"]),
]

/** Una persona de 48 años sin terceros molares (en el odontograma) y con un implante en la 46, en una atención abierta. */
async function setup(owner: OwnerFixture): Promise<{ patientId: string; encounterId: string; personId: string }> {
  const { page } = owner
  const slug = owner.org.slug
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName: "Carlos Paredes", docType: "DNI", docNumber: "41234567", birthDate: "1978-03-21" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const apiPath = patientApiPath(patient.id)
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", slug, {
    professionalTitle: "Cirujano dentista",
    registrationBody: "COP",
    registrationNumber: "12345",
  })
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Le sangran las encías" }, 201)
  for (const [tooth, variant] of [[18, "other_absence"], [28, "other_absence"], [38, "unerupted"], [48, "unerupted"]] as const) {
    await call(page, "POST", `${apiPath}/odontogram/entries`, slug, { toothNumber: tooth, condition: "missing_tooth", details: { variant }, encounterId: encounter.id }, 201)
  }
  await call(page, "POST", `${apiPath}/odontogram/entries`, slug, {
    toothNumber: 46,
    condition: "implant",
    details: { clinicallyObserved: true, quality: "good" },
    encounterId: encounter.id,
  }, 201)
  const person = await call<{ personId: string }>(page, "GET", `/api/people/by-patient/${patient.id}`, slug)
  return { patientId: patient.id, encounterId: encounter.id, personId: person.personId }
}

/**
 * Lo que se escribe en cada cara: las tres profundidades, «s» para el sangrado
 * y las tres recesiones. La 16, la 26 y la 14 tienen bolsas de 5 mm por fuera
 * con la encía en su lugar (periodontitis localizada); lo demás, la encía 2 mm
 * sobre la corona. No se usa el «1» delante de otro dígito: dos dígitos
 * seguidos escriben 10 a 15.
 */
function keysFor(tooth: number, face: "buccal" | "lingual"): string {
  const sick = [16, 26, 14].includes(tooth) && face === "buccal"
  return sick ? "5s35000" : "323-2-2-2"
}

test("periodontograma completo con el teclado, clasificado, firmado y comparado", async ({ owner }) => {
  test.setTimeout(240_000)
  const { page } = owner
  const slug = owner.org.slug
  const ids = await setup(owner)
  const apiPath = patientApiPath(ids.patientId)

  // En la atención es un bloque más: «Agregar Periodontograma» y «Empezar».
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${ids.encounterId}`))
  await page.getByRole("button", { name: "Agregar Periodontograma" }).click()
  await page.getByRole("button", { name: "Empezar", exact: true }).click()
  const capture = page.getByRole("dialog", { name: "Periodontograma" })
  await expect(capture).toBeVisible()
  // Las piezas ausentes no se piden: empieza en la 17 por fuera, con el campo nombrado.
  const first = capture.getByRole("textbox", { name: "Pieza 17, por fuera, distal, profundidad" })
  await expect(first).toBeFocused()

  // La movilidad se marca en la misma tarjeta y el foco vuelve al campo.
  await capture.getByRole("radiogroup", { name: "Movilidad de la 17" }).getByRole("radio", { name: "1" }).click()
  await expect(first).toBeFocused()

  // Todo con el teclado, cara por cara, sin tocar el ratón.
  for (const [tooth, face] of SEQUENCE) await page.keyboard.type(keysFor(tooth, face), { delay: 5 })
  await expect(capture.getByText("Sondaje completo")).toBeVisible()
  await expect(capture.getByText("No falta ninguna cara.")).toBeVisible()
  // La página entera cambia el tamaño de la ventana: la captura sigue abierta (la monta la atención).
  await page.screenshot({ path: test.info().outputPath("captura-completa.png"), fullPage: true })
  await expect(capture).toBeVisible()

  // La placa se marca aparte, en las cuatro caras de la pieza del odontograma.
  await capture.getByRole("tab", { name: "Placa" }).click()
  await capture.getByRole("checkbox", { name: "Pieza 16, por fuera: sin placa" }).press("Enter")
  await capture.getByRole("button", { name: /Sin placa en las \d+ que faltan/ }).click()
  await expect(capture.getByText("1 de 108 caras", { exact: false })).toBeVisible()
  await capture.getByRole("button", { name: "Listo" }).click()
  await expect(capture).toBeHidden()

  // Lo guardado: la pieza 16 tal como se escribió, la 17 con su movilidad y M1 en el odontograma.
  const list = await call<Array<{ id: string; pendingTeeth: number }>>(page, "GET", `${apiPath}/periodontal`, slug)
  expect(list).toHaveLength(1)
  expect(list[0]!.pendingTeeth).toBe(0)
  const chart = await call<{ teeth: Array<{ toothNumber: number; probingDepth: Array<number | null>; mobility: number | null; plaque: boolean[] | null }> }>(
    page,
    "GET",
    `${apiPath}/periodontal/${list[0]!.id}`,
    slug,
  )
  const t16 = chart.teeth.find((tooth) => tooth.toothNumber === 16)!
  expect(t16.probingDepth.slice(0, 3)).toEqual([5, 3, 5])
  expect(t16.plaque).toEqual([true, false, false, false])
  expect(chart.teeth.find((tooth) => tooth.toothNumber === 17)!.mobility).toBe(1)
  const odontogram = await call<{ history: Array<{ toothNumber: number; condition: string; details: { grade?: number } }> }>(page, "GET", `${apiPath}/odontogram`, slug)
  expect(odontogram.history.some((entry) => entry.toothNumber === 17 && entry.condition === "pathological_mobility" && entry.details.grade === 1)).toBe(true)

  // Clasificación guiada: odentIA propone con sus razones y el odontólogo confirma.
  const block = page.getByRole("region", { name: "Resumen y clasificación" })
  await expect(block.getByText("Estadio III · Grado B · Localizada").first()).toBeVisible()
  await block.getByLabel("Pérdida de hueso en la radiografía, en la pieza más afectada (%)").fill("40")
  await block.getByLabel("Cigarrillos al día").fill("0")
  await block.getByRole("button", { name: "Confirmar diagnóstico" }).click()
  await expect(page.getByText("Diagnóstico confirmado; quedó también en el diagnóstico de la atención")).toBeVisible()
  await expect(block.getByText(/Confirmado: Estadio III · Grado B · Localizada/)).toBeVisible()
  await block.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath("clasificacion.png") })

  // El cierre lo nombra y lo deja fijo.
  await call(page, "PATCH", `${apiPath}/encounters/${ids.encounterId}`, slug, { evolution: "Sondaje completo; se indica raspado por cuadrantes." })
  await page.reload()
  await page.getByRole("button", { name: "Finalizar y firmar" }).first().click()
  const closing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(closing.getByText("Periodontograma: 27 piezas y 1 implante.")).toBeVisible()
  await closing.getByRole("button", { name: "Finalizar y firmar" }).click()
  await expect(closing).toBeHidden()

  // Una reevaluación, cargada por la API, para comparar dos visitas.
  const second = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Reevaluación periodontal" }, 201)
  const reevaluation = await call<{ id: string }>(page, "POST", `${apiPath}/periodontal`, slug, { encounterId: second.id }, 201)
  for (const tooth of [17, 16, 26, 36]) {
    await call(page, "PUT", `${apiPath}/periodontal/${reevaluation.id}/teeth/${tooth}`, slug, {
      probingDepth: tooth === 26 ? [3, 3, 7, 3, 2, 3] : [3, 2, 3, 3, 2, 3],
      recession: [0, 0, 0, 0, 0, 0],
      bleeding: [false, false, tooth === 26, false, false, false],
    })
  }

  // En la ficha: Clínica sigue con cuatro secciones y Periodontograma va dentro de Odontograma.
  await gotoHydrated(page, tenant(slug, `/people/${ids.personId}?tab=odontograma`))
  await expect(page.getByRole("tablist", { name: "Secciones de Clínica" }).getByRole("tab")).toHaveText([
    "Antecedentes",
    "Odontograma",
    "Historia",
    "Documentos",
  ])
  await page.getByRole("tablist", { name: "Dentro de Odontograma" }).getByRole("tab", { name: "Periodontograma" }).click()
  await expect(page.getByRole("heading", { name: "Periodontograma" })).toBeVisible()
  await expect(page.getByText("Inicial", { exact: true })).toBeVisible()
  await page.getByRole("listitem").filter({ hasText: "Inicial" }).getByRole("button", { name: "Abrir" }).click()

  // El gráfico: cada pieza se elige con el teclado y su detalle se abre al lado.
  const piece = page.getByRole("button", { name: /^Pieza 16: bolsa máxima 5 mm/ })
  await piece.focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("button", { name: /^Pieza 15: / })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: "Pieza 15" })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("grafico-completo.png"), fullPage: true })

  // Comparar: el sitio que empeoró, dicho con palabras.
  await page.getByRole("button", { name: "Todos los periodontogramas" }).click()
  await page.getByRole("button", { name: "Comparar" }).click()
  await expect(page.getByText(/Un sitio empeoró: 26, distal por fuera/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("comparar.png"), fullPage: true })
})

/** Cuando falta una parte, el cierre la nombra y se firma como parcial. */
test("periodontograma a medias: el cierre dice lo que falta y se firma como parcial", async ({ owner }) => {
  const { page } = owner
  const slug = owner.org.slug
  const ids = await setup(owner)
  const apiPath = patientApiPath(ids.patientId)
  const chart = await call<{ id: string }>(page, "POST", `${apiPath}/periodontal`, slug, { encounterId: ids.encounterId }, 201)
  for (const tooth of UPPER) {
    await call(page, "PUT", `${apiPath}/periodontal/${chart.id}/teeth/${tooth}`, slug, {
      probingDepth: [3, 2, 3, 3, 2, 3],
      recession: [-1, -1, -1, -1, -1, -1],
    })
  }
  await call(page, "POST", `${apiPath}/encounters/${ids.encounterId}/diagnoses`, slug, { diagnosisCode: "K05.1", diagnosisType: "provisional" }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${ids.encounterId}`, slug, { evolution: "Control: se sondea la arcada superior." })
  await openEncounter(page, slug, ids)
  await page.getByRole("button", { name: "Finalizar y firmar" }).first().click()
  const closing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(closing.getByText(/Periodontograma sin terminar: falta abajo por dentro, de la 47 a la 37; abajo por fuera, de la 37 a la 47\./)).toBeVisible()
  await closing.getByRole("button", { name: "Firmar como parcial" }).click()
  await expect(closing).toBeHidden()
  const list = await call<Array<{ encounterStatus: string; pendingTeeth: number }>>(page, "GET", `${apiPath}/periodontal`, slug)
  expect(list[0]).toMatchObject({ encounterStatus: "finalizada", pendingTeeth: 14 })
})

async function openEncounter(page: Page, slug: string, ids: { patientId: string; encounterId: string }) {
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${ids.encounterId}`))
}
