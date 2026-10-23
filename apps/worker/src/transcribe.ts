import { reportAiUse } from "@odentia/agent"
import type { TranscribeFn } from "@odentia/services"
import type { Env } from "./env.js"

/** Lo que reportó el proveedor: segundos de audio o tokens; nada si no lo dijo. */
function transcriptionUsage(json: unknown): { audioSeconds?: number; inputTokens?: number; outputTokens?: number } {
  const body = (json ?? {}) as {
    duration?: unknown
    usage?: { type?: unknown; seconds?: unknown; input_tokens?: unknown; output_tokens?: unknown }
  }
  if (typeof body.duration === "number") return { audioSeconds: Math.ceil(body.duration) }
  if (typeof body.usage?.seconds === "number") return { audioSeconds: Math.ceil(body.usage.seconds) }
  if (typeof body.usage?.input_tokens === "number") {
    return {
      inputTokens: body.usage.input_tokens,
      ...(typeof body.usage.output_tokens === "number" ? { outputTokens: body.usage.output_tokens } : {}),
    }
  }
  return {}
}

/**
 * Transcriptor OpenAI-compatible (`/audio/transcriptions`, p.ej. Whisper).
 * Devuelve null cuando la transcripción está desactivada (sin modelo o key).
 */
export function createTranscriber(env: Env): TranscribeFn | null {
  const model = env.TRANSCRIBE_MODEL
  const baseUrl = env.TRANSCRIBE_BASE_URL ?? "https://api.openai.com/v1"
  // La clave de OpenAI del chat solo se reutiliza si su endpoint es el mismo
  // que el de transcripción: nunca se envía a otro host.
  const chatHost = env.LLM_OPENAI_BASE_URL ? new URL(env.LLM_OPENAI_BASE_URL).host : "api.openai.com"
  const sameProvider = new URL(baseUrl).host === chatHost
  const apiKey = env.TRANSCRIBE_API_KEY || (sameProvider ? env.LLM_OPENAI_API_KEY : "")
  if (!model || !apiKey) return null
  return async ({ bytes, mimeType, filename }) => {
    const form = new FormData()
    form.set("model", model)
    form.set("file", new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }), filename)
    // gpt-transcribe recibe los idiomas esperados en `languages` y rechaza que
    // lleguen junto con `language`, la pista única de los Whisper y los
    // gpt-4o-*-transcribe (guía «Migrating from Whisper to gpt-transcribe» de
    // OpenAI, leída el 2026-10-23). En multipart una lista va como `campo[]`.
    if (model.startsWith("gpt-transcribe")) form.append("languages[]", "es")
    else form.set("language", "es")
    // Los Whisper (whisper-1 de OpenAI y whisper-large-v3[-turbo] de Groq) solo
    // dicen cuánto duró el audio, que es lo que cobran, en verbose_json; los
    // gpt-4o-*-transcribe lo informan en `usage` con json.
    form.set("response_format", model.startsWith("whisper") ? "verbose_json" : "json")
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
    reportAiUse({ provider: "transcripcion", model, ...transcriptionUsage(json) })
    return text
  }
}
