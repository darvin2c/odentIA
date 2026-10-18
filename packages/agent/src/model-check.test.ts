import { describe, expect, it } from "vitest"
import { fakeModelStartProblem, type LlmSpec } from "./llm.js"
import { createModelChecker, MODEL_CHECK_TTL_MS, type ModelProbe } from "./model-check.js"

/** Un proveedor de mentira: cuenta las llamadas y falla si `down` está encendido. */
function probeDouble() {
  const calls: string[] = []
  const state = { down: false }
  const probe: ModelProbe = async (spec: LlmSpec) => {
    calls.push(spec.modelName)
    if (state.down) throw Object.assign(new Error("401"), { status: 401, error: { error: { message: "Incorrect API key" } } })
  }
  return { calls, probe, state }
}

describe("«El modelo responde»", () => {
  it("el resultado vale 10 minutos: abrir y cerrar el cajón no repite la llamada", async () => {
    let now = Date.parse("2026-10-16T15:00:00Z")
    const provider = probeDouble()
    const checker = createModelChecker({ openai: { apiKey: "k" } }, { now: () => now, probe: provider.probe })
    const first = await checker.check()
    expect(first).toEqual({ model: "gpt-6-luna", responds: true, problem: null, checkedAt: "2026-10-16T15:00:00.000Z" })
    now += MODEL_CHECK_TTL_MS - 1
    expect(await checker.check()).toBe(first)
    expect(provider.calls).toEqual(["gpt-6-luna"])
    // Pasados los 10 minutos se vuelve a comprobar.
    now += 1
    expect(checker.peek()).toBeNull()
    expect((await checker.check()).checkedAt).toBe("2026-10-16T15:10:00.000Z")
    expect(provider.calls).toHaveLength(2)
    // «Volver a comprobar» no espera a que venza.
    await checker.check({ fresh: true })
    expect(provider.calls).toHaveLength(3)
  })

  it("dos pantallas que preguntan a la vez comparten una sola llamada", async () => {
    const provider = probeDouble()
    const checker = createModelChecker({ fake: true }, { probe: provider.probe })
    const [a, b] = await Promise.all([checker.check(), checker.check()])
    expect(a).toBe(b)
    expect(provider.calls).toEqual(["fake"])
  })

  it("sin la clave del proveedor no responde y no llama a nadie; el motivo técnico queda para odentIA", async () => {
    const provider = probeDouble()
    const checker = createModelChecker({}, { probe: provider.probe })
    const result = await checker.check()
    expect(result).toMatchObject({ model: "gpt-6-luna", responds: false, problem: { code: "API_KEY_REQUIRED" } })
    expect(result.problem?.detail).toContain("LLM_OPENAI_API_KEY")
    expect(provider.calls).toEqual([])
  })

  it("si el proveedor rechaza la llamada no responde, con la clase del problema", async () => {
    const provider = probeDouble()
    provider.state.down = true
    const result = await createModelChecker({ openai: { apiKey: "k" } }, { probe: provider.probe }).check()
    expect(result).toMatchObject({ responds: false, problem: { code: "PROVIDER_REJECTED" } })
  })

  it("el modelo de demostración responde sin proveedor (desarrollo, pruebas y vistas previas)", async () => {
    expect(await createModelChecker({ fake: true }).check()).toMatchObject({ model: "fake", responds: true })
  })
})

describe("arranque con el modelo de demostración", () => {
  it("en producción con canales reales no arranca; en vistas previas, desarrollo y pruebas sí", () => {
    expect(fakeModelStartProblem({ LLM_MODEL: "fake", NODE_ENV: "production" }, true)).toMatch(/demostración/)
    expect(fakeModelStartProblem({ LLM_MODEL: " fake ", NODE_ENV: "production" }, true)).not.toBeNull()
    // Vista previa: la imagen fija production, pero los canales son simulados.
    expect(fakeModelStartProblem({ LLM_MODEL: "fake", NODE_ENV: "production" }, false)).toBeNull()
    expect(fakeModelStartProblem({ LLM_MODEL: "fake", NODE_ENV: "test" }, true)).toBeNull()
    expect(fakeModelStartProblem({ LLM_MODEL: "fake" }, true)).toBeNull()
    expect(fakeModelStartProblem({ NODE_ENV: "production" }, true)).toBeNull()
  })
})
