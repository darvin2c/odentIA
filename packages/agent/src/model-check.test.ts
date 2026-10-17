import { describe, expect, it } from "vitest"
import { fakeModelStartProblem, type LlmSpec } from "./llm.js"
import { checkAgentModels, createModelChecker, MODEL_CHECK_TTL_MS, type ModelProbe } from "./model-check.js"

/** Un proveedor de mentira: cuenta las llamadas y falla para los modelos de `down`. */
function probeDouble(down: string[] = []) {
  const calls: string[] = []
  const probe: ModelProbe = async (spec: LlmSpec) => {
    calls.push(spec.llm)
    if (down.includes(spec.llm)) throw Object.assign(new Error("401"), { status: 401, error: { error: { message: "Incorrect API key" } } })
  }
  return { calls, probe, down }
}

describe("«El modelo responde»", () => {
  it("el resultado vale 10 minutos: abrir y cerrar el cajón no repite la llamada", async () => {
    let now = Date.parse("2026-10-16T15:00:00Z")
    const provider = probeDouble()
    const checker = createModelChecker({ openai: { apiKey: "k" }, anthropic: { apiKey: "k" } }, { now: () => now, probe: provider.probe })
    const first = await checker.check("chatgpt_6")
    expect(first).toEqual({ llm: "chatgpt_6", responds: true, problem: null, checkedAt: "2026-10-16T15:00:00.000Z" })
    now += MODEL_CHECK_TTL_MS - 1
    expect(await checker.check("chatgpt_6")).toBe(first)
    expect(provider.calls).toEqual(["chatgpt_6"])
    // Pasados los 10 minutos se vuelve a comprobar.
    now += 1
    expect(checker.peek("chatgpt_6")).toBeNull()
    expect((await checker.check("chatgpt_6")).checkedAt).toBe("2026-10-16T15:10:00.000Z")
    expect(provider.calls).toEqual(["chatgpt_6", "chatgpt_6"])
    // «Volver a comprobar» no espera a que venza.
    await checker.check("chatgpt_6", { fresh: true })
    expect(provider.calls).toHaveLength(3)
  })

  it("dos pantallas que preguntan a la vez comparten una sola llamada", async () => {
    const provider = probeDouble()
    const checker = createModelChecker({ fake: true }, { probe: provider.probe })
    const [a, b] = await Promise.all([checker.check("claude_5_5"), checker.check("claude_5_5")])
    expect(a).toBe(b)
    expect(provider.calls).toEqual(["claude_5_5"])
  })

  it("sin la clave del proveedor no responde y no llama a nadie; el motivo técnico queda para odentIA", async () => {
    const provider = probeDouble()
    const checker = createModelChecker({ anthropic: { apiKey: "k" } }, { probe: provider.probe })
    const result = await checker.check("chatgpt_6")
    expect(result).toMatchObject({ responds: false, problem: { code: "API_KEY_REQUIRED" } })
    expect(result.problem?.detail).toContain("LLM_OPENAI_API_KEY")
    expect(provider.calls).toEqual([])
  })

  it("si el elegido no responde, dice si el otro sí, sin el motivo técnico", async () => {
    const provider = probeDouble(["chatgpt_6"])
    const checker = createModelChecker({ openai: { apiKey: "k" }, anthropic: { apiKey: "k" } }, { probe: provider.probe })
    const otherWorks = await checkAgentModels(checker, "chatgpt_6")
    expect(otherWorks.status).toMatchObject({ llm: "chatgpt_6", responds: false, other: { llm: "claude_5_5", responds: true } })
    expect(JSON.stringify(otherWorks.status)).not.toMatch(/Incorrect|401|clave/)
    expect(otherWorks.failed.map((item) => [item.llm, item.problem?.code])).toEqual([["chatgpt_6", "PROVIDER_REJECTED"]])
    // Con el elegido respondiendo no se prueba el otro.
    const fine = await checkAgentModels(checker, "claude_5_5")
    expect(fine).toMatchObject({ status: { responds: true, other: null }, failed: [] })
    // Ninguno responde.
    provider.down.push("claude_5_5")
    const none = await checkAgentModels(checker, "chatgpt_6", { fresh: true })
    expect(none.status.other).toEqual({ llm: "claude_5_5", responds: false })
    expect(none.failed).toHaveLength(2)
  })

  it("el modelo de demostración responde sin proveedor (desarrollo, pruebas y vistas previas)", async () => {
    expect(await createModelChecker({ fake: true }).check("chatgpt_6")).toMatchObject({ responds: true })
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
