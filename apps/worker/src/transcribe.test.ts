import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "./env.js"
import { createTranscriber } from "./transcribe.js"

/** Lo que el worker le envía al proveedor con cada modelo, sin llamarlo de verdad. */
async function formSentWith(model: string) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    void init
    return new Response(JSON.stringify({ text: "Quiero cambiar mi cita", usage: { type: "duration", seconds: 4 } }), { status: 200 })
  })
  vi.stubGlobal("fetch", fetchMock)
  const transcribe = createTranscriber({ TRANSCRIBE_MODEL: model, TRANSCRIBE_API_KEY: "clave-de-prueba" } as Env)
  const text = await transcribe?.({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg", filename: "nota.ogg" })
  const form = fetchMock.mock.calls[0]?.[1].body as FormData
  return { text, form }
}

afterEach(() => vi.unstubAllGlobals())

describe("transcripción de notas de voz (#158)", () => {
  it("gpt-transcribe recibe el español en `languages` y nunca también en `language`", async () => {
    const { text, form } = await formSentWith("gpt-transcribe")
    expect(text).toBe("Quiero cambiar mi cita")
    expect(form.getAll("languages[]")).toEqual(["es"])
    expect(form.has("language")).toBe(false)
    expect(form.get("response_format")).toBe("json")
  })

  it("Whisper y gpt-4o-*-transcribe siguen con `language`", async () => {
    for (const model of ["whisper-1", "whisper-large-v3-turbo", "gpt-4o-mini-transcribe"]) {
      const { form } = await formSentWith(model)
      expect(form.get("language")).toBe("es")
      expect(form.has("languages[]")).toBe(false)
    }
  })

  it("sin modelo la transcripción queda apagada", () => {
    expect(createTranscriber({ TRANSCRIBE_MODEL: "", TRANSCRIBE_API_KEY: "clave-de-prueba" } as Env)).toBeNull()
  })
})
