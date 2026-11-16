import { expect, it } from "vitest"
import { discardableHere } from "./encounter-discard"

const blocks = (filled: string[] = []) =>
  ["consulta", "examen", "hallazgos", "procedimientos", "plan", "documentos", "evolucion"].map((key) => ({
    key,
    empty: !filled.includes(key),
  }))

it("«Descartar» solo con la atención vacía de verdad: no con un motivo recién escrito ni con algo indicado (B3d)", () => {
  expect(discardableHere({ texts: ["", "", ""], indicated: 0, sections: blocks() })).toBe(true)
  // El motivo escrito y aún sin guardar ya la llena.
  expect(discardableHere({ texts: ["Dolor en la 46", "", ""], indicated: 0, sections: blocks(["consulta"]) })).toBe(false)
  // Con un tratamiento indicado, solo «Anular esta atención…».
  expect(discardableHere({ texts: ["", "", ""], indicated: 1, sections: blocks(["plan"]) })).toBe(false)
  // Lo que trajo su cita («Hoy viene a…») no la llena.
  expect(discardableHere({ texts: ["", "", ""], indicated: 0, sections: blocks(["plan"]) })).toBe(true)
  // Un diagnóstico o un documento, tampoco se descarta.
  expect(discardableHere({ texts: [""], indicated: 0, sections: blocks(["hallazgos"]) })).toBe(false)
  expect(discardableHere({ texts: [""], indicated: 0, sections: blocks(["documentos"]) })).toBe(false)
})
