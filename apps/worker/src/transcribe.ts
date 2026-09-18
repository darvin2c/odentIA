import type { TranscribeFn } from "@odentia/services"
import type { Env } from "./env.js"

/**
 * Transcriptor OpenAI-compatible (`/audio/transcriptions`, p.ej. Whisper).
 * Devuelve null cuando la transcripción está desactivada (sin modelo o key).
 */
export function createTranscriber(env: Env): TranscribeFn | null {
  const model = env.TRANSCRIBE_MODEL
  const apiKey = env.TRANSCRIBE_API_KEY || env.LLM_API_KEY
  if (!model || !apiKey) return null
  const baseUrl = env.TRANSCRIBE_BASE_URL ?? "https://api.openai.com/v1"
  return async ({ bytes, mimeType, filename }) => {
    const form = new FormData()
    form.set("model", model)
    form.set("file", new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }), filename)
    form.set("language", "es")
    form.set("response_format", "json")
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!res.ok) throw new Error(`Transcripción falló: HTTP ${res.status}`)
    const json: unknown = await res.json()
    const text =
      json && typeof json === "object" && "text" in json && typeof json.text === "string"
        ? json.text
        : null
    if (text === null) throw new Error("Transcripción sin texto")
    return text
  }
}
