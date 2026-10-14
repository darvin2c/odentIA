import type { SearchEmbedder } from "@odentia/services"

/**
 * Quien vectoriza para la búsqueda por significado (ADR 0021). Es de la
 * plataforma, igual para todas las clínicas: no usa el modelo propio de cada
 * una, porque no todos ofrecen vectores. Un solo protocolo, el endpoint
 * `/embeddings` compatible con OpenAI; la URL la fija el operador.
 */
export interface EmbeddingsEnv {
  /** `fake`: vectores por letras, sin red (desarrollo y pruebas). Vacío: sin búsqueda por significado. */
  EMBEDDINGS_MODEL?: string
  EMBEDDINGS_BASE_URL?: string
  EMBEDDINGS_API_KEY?: string
  EMBEDDINGS_TIMEOUT_MS?: number
}

export const FAKE_EMBEDDINGS_MODEL = "fake-trigramas-256"
const FAKE_DIMENSIONS = 256

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** FNV-1a de 32 bits: reparte cada trozo en una dimensión de forma estable. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

/**
 * Doble para desarrollo y pruebas: un vector por los trozos de tres letras del
 * texto. Encuentra palabras mal escritas («blanquiamiento») pero NO entiende
 * significado («dientes amarillos» no lleva a blanqueamiento): no acredita la
 * calidad de ningún proveedor.
 */
export function fakeEmbedder(): SearchEmbedder {
  return {
    model: FAKE_EMBEDDINGS_MODEL,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(FAKE_DIMENSIONS).fill(0)
        for (const word of normalizeText(text).split(" ")) {
          if (!word) continue
          const padded = ` ${word} `
          for (let i = 0; i + 3 <= padded.length; i++) {
            const index = hash(padded.slice(i, i + 3)) % FAKE_DIMENSIONS
            vector[index] = (vector[index] ?? 0) + 1
          }
        }
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
        return vector.map((value) => value / norm)
      })
    },
  }
}

/** Proveedor real compatible con OpenAI (`POST {base}/embeddings`). */
export function openAiEmbedder(spec: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }): SearchEmbedder {
  const url = `${spec.baseUrl.replace(/\/+$/, "")}/embeddings`
  return {
    model: spec.model,
    async embed(texts) {
      if (!texts.length) return []
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${spec.apiKey}` },
        body: JSON.stringify({ model: spec.model, input: texts }),
        signal: AbortSignal.timeout(spec.timeoutMs ?? 20_000),
      })
      // Nunca se repite el texto del proveedor: solo el código.
      if (!response.ok) throw new Error(`El proveedor de vectores respondió ${response.status}`)
      const body = (await response.json()) as { data?: Array<{ index: number; embedding: number[] }> }
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
      if (data.length !== texts.length) throw new Error("El proveedor de vectores no devolvió uno por texto")
      return data.map((item) => item.embedding)
    },
  }
}

/** El de la instalación: real con modelo, URL y clave; el doble con `fake`; ninguno si no hay modelo. */
export function embedderFromEnv(env: EmbeddingsEnv): SearchEmbedder | undefined {
  const model = env.EMBEDDINGS_MODEL?.trim()
  if (!model) return undefined
  if (model === "fake") return fakeEmbedder()
  if (!env.EMBEDDINGS_BASE_URL || !env.EMBEDDINGS_API_KEY) return undefined
  return openAiEmbedder({
    baseUrl: env.EMBEDDINGS_BASE_URL,
    apiKey: env.EMBEDDINGS_API_KEY,
    model,
    timeoutMs: env.EMBEDDINGS_TIMEOUT_MS,
  })
}
