import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./api"
import { createQueryClient } from "./query-client"

const toastError = vi.hoisted(() => vi.fn())
const toastDismiss = vi.hoisted(() => vi.fn())
vi.mock("@odentia/ui", () => ({ toast: { error: toastError, dismiss: toastDismiss } }))

async function failingSave(error: Error): Promise<void> {
  const client = createQueryClient()
  const save = client.getMutationCache().build(client, { mutationFn: () => Promise.reject(error) })
  await save.execute(undefined).catch(() => undefined)
  await vi.runAllTimersAsync()
}

describe("un guardado que la verificación en dos pasos rechaza", () => {
  const reload = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    toastError.mockClear()
    toastDismiss.mockClear()
    reload.mockClear()
    vi.stubGlobal("window", { location: { reload } })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(["TWO_FACTOR_REQUIRED", "TWO_FACTOR_CODE_REQUIRED"])("con %s avisa una sola vez, y recarga solo si la persona lo pide", async (code) => {
    await failingSave(new ApiError(403, { code, message: "Esta clínica pide verificación en dos pasos" }))
    expect(toastDismiss).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    const options = toastError.mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } }
    expect(options.action.label).toBe("Verificar ahora")
    options.action.onClick()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("ofrecido el paso, una consulta rechazada tampoco recarga: lo escrito sigue ahí", async () => {
    await failingSave(new ApiError(403, { code: "TWO_FACTOR_REQUIRED", message: "Pide verificación" }))
    const failing = () => Promise.reject(new ApiError(403, { code: "TWO_FACTOR_REQUIRED", message: "Pide verificación" }))
    await createQueryClient().fetchQuery({ queryKey: ["algo"], queryFn: failing }).catch(() => undefined)
    expect(reload).not.toHaveBeenCalled()
  })

  it("no agrega nada a otros errores: los dice su formulario", async () => {
    await failingSave(new ApiError(400, { code: "VALIDATION", message: "Falta un dato" }))
    expect(toastError).not.toHaveBeenCalled()
    expect(toastDismiss).not.toHaveBeenCalled()
  })
})
