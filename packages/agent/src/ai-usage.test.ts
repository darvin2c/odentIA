import { describe, expect, it } from "vitest"
import { costMicrosOf, reportAiUse, summarizeAiUses, takeAiUsage, withAiMeter } from "./ai-usage.js"

describe("costo de una llamada", () => {
  it("cobra aparte lo leído y lo escrito en la caché de Claude", () => {
    // 600 nuevos a 0,10 + 2.000 leídos a 0,01 + 400 escritos a 0,125 + 50 de salida a 0,50 (USD por millón).
    expect(
      costMicrosOf({ model: "claude-haiku-5-5", inputTokens: 3_000, cachedInputTokens: 2_000, cacheWriteTokens: 400, outputTokens: 50 }),
    ).toBe(60 + 20 + 50 + 25)
  })

  it("el audio se cobra por minuto y los vectores solo por entrada", () => {
    expect(costMicrosOf({ model: "whisper-1", audioSeconds: 90 })).toBe(9_000)
    expect(costMicrosOf({ model: "text-embedding-3-small", inputTokens: 1_000 })).toBe(20)
  })

  it("Jev cobra solo la entrada: un mensaje típico de Recepción cuesta 57 millonésimas", () => {
    // Camino, conocimiento e interés: ~1 360 tokens a 0,042 USD por millón; la salida no se cobra.
    expect(costMicrosOf({ model: "jev-1.13.0", inputTokens: 1_360, outputTokens: 12 })).toBe(57)
  })

  it("sin precio o sin uso reportado no hay costo: nunca 0 ni un estimado", () => {
    // Una versión de Jev que odentIA no fijó ni midió no tiene fila.
    expect(costMicrosOf({ model: "jev-1.14.0", inputTokens: 500, outputTokens: 10 })).toBeNull()
    expect(costMicrosOf({ model: "gpt-6-luna" })).toBeNull()
    // Salida en un modelo que solo tiene precio de entrada: el precio no lo cubre.
    expect(costMicrosOf({ model: "text-embedding-3-small", inputTokens: 10, outputTokens: 5 })).toBeNull()
  })

  it("reconoce el modelo aunque el proveedor le añada la fecha", () => {
    expect(costMicrosOf({ model: "gpt-6-luna-2026-07-01", inputTokens: 1_000, outputTokens: 0 })).toBe(100)
  })
})

describe("medir una operación", () => {
  it("agrupa por proveedor y modelo y deja el grupo sin costo si una llamada no reportó", () => {
    const entries = summarizeAiUses([
      { provider: "openai", model: "gpt-6-luna", inputTokens: 1_000, outputTokens: 100 },
      { provider: "openai", model: "gpt-6-luna", inputTokens: 2_000, cachedInputTokens: 1_000, outputTokens: 100 },
      { provider: "jev", model: "jev-1.13.0", inputTokens: 300, outputTokens: 5 },
      { provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 100, outputTokens: 10 },
      { provider: "anthropic", model: "claude-haiku-5-5" },
    ])
    expect(entries).toEqual([
      {
        provider: "openai",
        model: "gpt-6-luna",
        calls: 2,
        inputTokens: 3_000,
        cachedInputTokens: 1_000,
        cacheWriteTokens: null,
        outputTokens: 200,
        audioSeconds: null,
        costMicros: 200 + 10 + 100,
      },
      // 300 de entrada a 0,042: 12,6 millonésimas, redondeadas; la salida de Jev no se cobra.
      { provider: "jev", model: "jev-1.13.0", calls: 1, inputTokens: 300, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 5, audioSeconds: null, costMicros: 13 },
      { provider: "anthropic", model: "claude-haiku-5-5", calls: 2, inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, audioSeconds: null, costMicros: null },
    ])
  })

  it("guarda lo gastado aunque la operación falle, y fuera de una operación no anota nada", async () => {
    reportAiUse({ provider: "openai", model: "gpt-6-luna", inputTokens: 1 })
    const saved: unknown[] = []
    await expect(
      withAiMeter(
        async () => {
          reportAiUse({ provider: "openai", model: "gpt-6-luna", inputTokens: 1_000, outputTokens: 0 })
          throw new Error("el proveedor cortó")
        },
        async (entries) => {
          saved.push(...entries)
        },
      ),
    ).rejects.toThrow("el proveedor cortó")
    expect(saved).toEqual([expect.objectContaining({ calls: 1, costMicros: 100 })])
  })

  it("lo que la corrida ya guardó con su fila no se guarda otra vez al terminar", async () => {
    const saved: unknown[] = []
    const taken = await withAiMeter(
      async () => {
        reportAiUse({ provider: "openai", model: "gpt-6-luna", inputTokens: 1_000, outputTokens: 0 })
        const first = takeAiUsage()
        reportAiUse({ provider: "jev", model: "jev-1.13.0", inputTokens: 10, outputTokens: 1 })
        return first
      },
      async (entries) => {
        saved.push(...entries)
      },
    )
    expect(taken).toEqual([expect.objectContaining({ model: "gpt-6-luna", calls: 1 })])
    expect(saved).toEqual([expect.objectContaining({ model: "jev-1.13.0", calls: 1 })])
  })

  it("un fallo al guardar no cambia el resultado de la operación", async () => {
    const result = await withAiMeter(
      async () => {
        reportAiUse({ provider: "openai", model: "gpt-6-luna", inputTokens: 1 })
        return "listo"
      },
      async () => {
        throw new Error("base caída")
      },
    )
    expect(result).toBe("listo")
  })
})
