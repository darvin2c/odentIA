import { env } from "../env.js";

/**
 * Mapea LLM_MODEL/LLM_API_KEY/LLM_BASE_URL a las variables que cada
 * proveedor espera (initChatModel las lee del entorno). Otro proveedor =
 * extender este mapa, sin tocar el grafo.
 */
export function applyLlmEnv(): void {
  const model = env.LLM_MODEL;
  if (model === "fake") return;
  const provider = model.split(":")[0];
  if (env.LLM_API_KEY) {
    if (provider === "openai") process.env["OPENAI_API_KEY"] ??= env.LLM_API_KEY;
    else if (provider === "anthropic") process.env["ANTHROPIC_API_KEY"] ??= env.LLM_API_KEY;
    else if (provider === "google-genai" || provider === "google") {
      process.env["GOOGLE_API_KEY"] ??= env.LLM_API_KEY;
    }
  }
  if (env.LLM_BASE_URL && provider === "openai") {
    process.env["OPENAI_BASE_URL"] ??= env.LLM_BASE_URL;
  }
}

/**
 * Callback de Langfuse solo si hay env (import dinámico opcional: sin las
 * keys no se carga nada). Devuelve [] si no aplica.
 */
export async function langfuseCallbacks(): Promise<import("@langchain/core/callbacks/manager").Callbacks> {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return [];
  try {
    const { CallbackHandler } = (await import("langfuse-langchain")) as unknown as {
      CallbackHandler: new (opts: Record<string, string | undefined>) => never;
    };
    const handler = new CallbackHandler({
      publicKey: LANGFUSE_PUBLIC_KEY,
      secretKey: LANGFUSE_SECRET_KEY,
      baseUrl: LANGFUSE_HOST,
    });
    return [handler] as unknown as import("@langchain/core/callbacks/manager").Callbacks;
  } catch (error) {
    console.warn("worker: langfuse-langchain no instalado, sin trazas", error);
    return [];
  }
}
