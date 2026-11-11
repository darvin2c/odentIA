import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { HelpWriter } from "@odentia/services"
import { reportReplyUse } from "./ai-usage.js"
import { createConfiguredChatModel, type PlatformLlm, resolveLlmSpec } from "./llm.js"

/**
 * Quien redacta en la Ayuda (ADR 0178): el modelo que escribe de la plataforma,
 * solo cuando Jev encontró la respuesta repartida entre varias de la guía. No
 * reintenta y no espera: si tarda, la Ayuda ofrece esas respuestas para elegir,
 * como siempre. Lo que gasta se anota en la operación en curso (origen `ayuda`).
 */
const WRITER_TIMEOUT_MS = 8_000

/**
 * El doble sin proveedor (`LLM_MODEL=fake`): une la primera frase de cada texto,
 * para ver el recorrido en desarrollo y en las pruebas. No acredita cómo
 * redacta ningún modelo.
 */
export function fakeHelpWriter(): HelpWriter {
  return async ({ user }) => {
    const texts = user.split(/\n\n/).filter((block) => block.startsWith("Texto "))
    const first = texts.map((block) => (block.split("\n").slice(1).join(" ").match(/^.*?[.!?](?=\s|$)/)?.[0] ?? "").trim())
    return first.filter(Boolean).join(" ") || null
  }
}

/** Nulo si la plataforma no tiene con qué redactar: la Ayuda sigue sin eso. */
export function createHelpWriter(platform: PlatformLlm): HelpWriter | null {
  if (platform.fake) return fakeHelpWriter()
  if (!platform.openai?.apiKey) return null
  const spec = { ...resolveLlmSpec(platform), timeoutMs: WRITER_TIMEOUT_MS, maxRetries: 0 }
  return async ({ system, user }) => {
    const model = await createConfiguredChatModel(spec, { temperature: 0 })
    const reply = await model.invoke([new SystemMessage(system), new HumanMessage(user)])
    reportReplyUse(spec.provider, spec.modelName, reply)
    return typeof reply.content === "string" ? reply.content : null
  }
}
