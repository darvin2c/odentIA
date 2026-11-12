/** La skill arma el plan de la clínica: cada servicio con su nombre y su código de la biblioteca. */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import sharp from "sharp"
import { expect, it } from "vitest"
import { buildClinicSetupPlan, clinicSetupPlanPdf, loadLibrary } from "./clinic-setup-source.js"

const SEEDS = resolve(__dirname, "../../db/seeds")

it("lee la biblioteca con el nombre entero (lleva comas) y el código del país", () => {
  const library = loadLibrary(SEEDS, "dental", "PE")
  expect(library.get("ortodoncia-integral-denticion-adulta")).toEqual({
    key: "ortodoncia-integral-denticion-adulta",
    name: "Ortodoncia integral, dentición adulta",
    code: "D8090",
  })
  expect(library.get("control-de-ortodoncia")?.code).toBe("D8670")
})

it("arma el plan con el logo dentro, dice lo que la biblioteca no tiene y sale en PDF", async () => {
  const folder = mkdtempSync(join(tmpdir(), "carga-"))
  writeFileSync(join(folder, "logo.png"), await sharp({ create: { width: 40, height: 40, channels: 3, background: "#ce6921" } }).png().toBuffer())
  writeFileSync(
    join(folder, "clinica.fuente.json"),
    JSON.stringify({
      product: "dental",
      countryCode: "PE",
      clinic: "Dra. Prueba",
      slug: "dra-prueba",
      brand: { color: "#CE6921", logo: { path: "logo.png" } },
      branches: [{ key: "principal", name: "Principal" }],
      services: [
        { template: "control-de-ortodoncia", name: "Control de alineadores", priceCents: 10_000, currency: "USD" },
        { template: "no-existe", priceCents: 100, currency: "PEN" },
        { name: "Propio sin código", specialty: "Ortodoncia y Ortopedia Maxilar", priceCents: 100, currency: "PEN" },
      ],
      review: { decisions: ["Día de pago: el 1."] },
    }),
  )
  const { plan, review, library, problems } = buildClinicSetupPlan(join(folder, "clinica.fuente.json"), SEEDS)
  expect(plan.brand?.logo).toMatchObject({ name: "logo.png", mime: "image/png" })
  expect(plan).not.toHaveProperty("review")
  expect(review.decisions).toEqual(["Día de pago: el 1."])
  expect(problems).toEqual([
    "Servicio 2: «no-existe» no está en la biblioteca",
    "Servicio 3 («Propio sin código»): uno propio lleva su código oficial",
  ])
  const pdf = await clinicSetupPlanPdf(plan, review, library, { number: 1, date: "2026-11-12" })
  expect(pdf.pages).toBe(1)
})
