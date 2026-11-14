import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { declaredFormDetail } from "./documentos-panel"

declareProduct(bareProduct("dental"))

// Auditor, 14 nov (11): la fila ponía la fecha de revisión delante de «Lo envió».
describe("la fila de lo que envió el paciente en Documentos", () => {
  const sent = {
    createdAt: "2026-11-10T15:00:00.000Z",
    submittedAt: "2026-11-10T16:00:00.000Z",
    finalizedAt: "2026-11-14T15:00:00.000Z",
    status: "finalizado" as const,
  }
  it("cada fecha dice lo que es: cuándo lo envió y cuándo se revisó", () => {
    const line = declaredFormDetail(sent, "Marta", " desde su enlace")
    expect(line).toMatch(/^Lo envió Marta desde su enlace el \S*10\S* · revisado el \S*14\S*$/)
    expect(declaredFormDetail({ ...sent, status: "borrador", finalizedAt: null }, "Marta", "")).toMatch(
      /^Lo envió Marta el \S*10\S*$/,
    )
  })
})
