import type { ModelChecker, ModelCheckResult, PlatformLlm } from "@odentia/agent"
import type { Db } from "@odentia/db"
import { describe, expect, it } from "vitest"
import { checkOrgModel, FRESH_MODEL_CHECK_GAP_MS } from "./agent-model.js"

/** Un comprobador que cuenta las llamadas nuevas al modelo y guarda la última, como el real. */
function countingChecker() {
  let fresh = 0
  let saved: ModelCheckResult | null = null
  const checker: ModelChecker = {
    async check(options) {
      if (options?.fresh || !saved) {
        fresh++
        saved = { model: "gpt-6-luna", responds: true, problem: null, checkedAt: new Date(fresh * 1000).toISOString() }
      }
      return saved
    },
    peek: () => saved,
  }
  return { checker, fresh: () => fresh }
}

describe("«Volver a comprobar» el modelo", () => {
  it("llama al modelo como mucho una vez por minuto y clínica; antes responde lo guardado", async () => {
    const { checker, fresh } = countingChecker()
    // Lo guardado no llama a nadie ni registra uso: la base no se toca.
    const deps = { db: {} as Db, llm: {} as PlatformLlm, modelChecker: checker }
    const t0 = 1_000_000
    const first = await checkOrgModel(deps, "org_a", { fresh: true, now: t0 })
    expect(fresh()).toBe(1)
    // En bucle dentro del minuto: siempre lo guardado.
    for (let i = 1; i <= 5; i++) {
      const again = await checkOrgModel(deps, "org_a", { fresh: true, now: t0 + i * 1000 })
      expect(again.checkedAt).toBe(first.checkedAt)
    }
    expect(fresh()).toBe(1)
    // Otra clínica tiene su propio minuto.
    await checkOrgModel(deps, "org_b", { fresh: true, now: t0 + 2000 })
    expect(fresh()).toBe(2)
    // Pasado el minuto, sí vuelve a comprobar.
    const later = await checkOrgModel(deps, "org_a", { fresh: true, now: t0 + FRESH_MODEL_CHECK_GAP_MS })
    expect(fresh()).toBe(3)
    expect(later.checkedAt).not.toBe(first.checkedAt)
  })
})
