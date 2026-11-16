import { expect, it } from "vitest"
import { cariesOnRestoredFaces } from "./index.js"

const row = (toothNumber: number, surface: string, condition: string, encounterId: string, details: unknown = {}) => ({
  toothNumber,
  surface,
  condition,
  details,
  encounterId,
})

it("avisa la cara con caries y restauración a la vez si alguna es de hoy, y no la restauración ya en mal estado (C41)", () => {
  const rows = [
    // 36 oclusal: la resina de antes y la caries de hoy.
    row(36, "occlusal", "definitive_restoration", "antes", { variant: "resin" }),
    row(36, "occlusal", "caries", "hoy", { variant: "dentin" }),
    // 36 mesial: solo caries.
    row(36, "mesial", "caries", "hoy"),
    // 46 distal: las dos de antes; hoy no se tocó.
    row(46, "distal", "definitive_restoration", "antes"),
    row(46, "distal", "caries", "antes"),
    // 26 oclusal: ya se registró en mal estado.
    row(26, "occlusal", "definitive_restoration", "antes", { quality: "poor" }),
    row(26, "occlusal", "caries", "hoy"),
  ]
  expect(cariesOnRestoredFaces(rows, "hoy")).toEqual([{ toothNumber: 36, surface: "occlusal" }])
})
