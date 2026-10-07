import { initChatModel } from "langchain/chat_models/universal"
import { FakeChatModel } from "./fake-model.js"

export interface LlmCredentials {
  apiKey?: string
  baseUrl?: string
}

/** Proveedor por prefijo del modelo (openai, anthropic, google-genai…). */
export function providerOf(modelName: string): string {
  return modelName.split(":")[0] ?? ""
}

/**
 * Modelo concreto con opciones por llamada, sin mutar el entorno global:
 * apiKey directa y, solo para openai (único con base configurable en el
 * mapa actual), configuration.baseURL. Sin credenciales, initChatModel lee
 * el entorno del proceso.
 */
export async function createConfiguredChatModel(
  modelName: string,
  creds: LlmCredentials = {},
) {
  if (modelName === "fake") return new FakeChatModel({})
  const options: { apiKey?: string; configuration?: { baseURL: string } } = {}
  if (creds.apiKey) options.apiKey = creds.apiKey
  if (creds.baseUrl && providerOf(modelName) === "openai") {
    options.configuration = { baseURL: creds.baseUrl }
  }
  return initChatModel(modelName, options)
}
