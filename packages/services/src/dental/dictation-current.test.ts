import type { Db } from "@odentia/db"
import { describe, expect, it } from "vitest"
// Por el índice, que carga primero los productos (ver `index.ts`).
import { DENTAL_DICTATION, DICTATION_FINDINGS } from "./index.js"
import type { DentalDictationContext } from "./dictation.js"

/**
 * Mesa del 23 nov: Clío dicta el implante, la endodoncia, el espigo-muñón y la
 * impactación, y no vuelve a proponer lo de toda la pieza que el paciente ya
 * tiene vigente. Sin base: la regla se decide antes de buscar el diagnóstico.
 */

const context = (current: string[]): DentalDictationContext => ({
  strictVariants: false,
  current: new Set(current),
  anatomy: new Map(),
  pulp: new Map(),
})

// Una base que no debe tocarse: si la regla no corta antes, la prueba falla.
const noDb = new Proxy({}, { get: () => { throw new Error("no debía consultar la base") } }) as unknown as Db

const prepare = (payload: Record<string, unknown>, current: string[]) =>
  DENTAL_DICTATION.prepare(noDb, "odontograma", payload, { diagnosisSystem: "ICD-10", product: context(current) })

describe("lo que Clío dicta del odontograma", () => {
  it("dicta los cuatro que antes pedían «Observé clínicamente»", () => {
    const codes = DICTATION_FINDINGS.map((finding) => finding.code)
    for (const code of ["implant", "root_canal_treatment", "post_and_core", "impaction"]) expect(codes).toContain(code)
    for (const code of ["pathological_mobility", "rotation"]) expect(codes).not.toContain(code)
  })

  it("no propone lo de toda la pieza que ya está vigente en esa pieza", async () => {
    expect(await prepare({ condition: "implant", toothNumber: 36, quality: "good" }, ["36:implant"])).toBeNull()
    expect(await prepare({ condition: "impaction", toothNumber: 48 }, ["48:impaction"])).toBeNull()
    expect(await prepare({ condition: "Espigo-muñón", toothNumber: 15, quality: "good" }, ["15:post_and_core"])).toBeNull()
  })

  it("sí propone lo de otra pieza, otro hallazgo y lo que va por cara", async () => {
    // Sigue de largo hasta el diagnóstico (que aquí sería la base): no se descarta.
    const proposed = (payload: Record<string, unknown>, current: string[]) =>
      prepare(payload, current).catch(() => "sigue")
    expect(await proposed({ condition: "impaction", toothNumber: 38 }, ["48:impaction"])).not.toBeNull()
    expect(await proposed({ condition: "implant", toothNumber: 36, quality: "good" }, ["46:implant", "36:crown"])).not.toBeNull()
    expect(await proposed({ condition: "caries", toothNumber: 26, surfaces: ["oclusal"] }, ["26:caries"])).not.toBeNull()
  })
})
