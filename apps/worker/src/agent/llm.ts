import { env } from "../env.js"

/**
 * Callback de Langfuse solo si hay env (import dinámico opcional: sin las
 * keys no se carga nada). Devuelve [] si no aplica.
 */
export async function langfuseCallbacks(): Promise<
  import("@langchain/core/callbacks/manager").Callbacks
> {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = env
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return []
  try {
    const { CallbackHandler } = (await import("langfuse-langchain")) as unknown as {
      CallbackHandler: new (opts: Record<string, string | undefined>) => never
    }
    const handler = new CallbackHandler({
      publicKey: LANGFUSE_PUBLIC_KEY,
      secretKey: LANGFUSE_SECRET_KEY,
      baseUrl: LANGFUSE_HOST,
    })
    return [handler] as unknown as import("@langchain/core/callbacks/manager").Callbacks
  } catch (error) {
    console.warn("worker: langfuse-langchain no instalado, sin trazas", error)
    return []
  }
}
