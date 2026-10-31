import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./api"
import { createQueryClient } from "./query-client"

const toastError = vi.hoisted(() => vi.fn())
vi.mock("@odentia/ui", () => ({ toast: { error: toastError } }))

function asks(code: string): ApiError {
  return new ApiError(403, { code, message: "Esta clínica pide verificación en dos pasos" })
}

async function failingSave(error: Error): Promise<void> {
  const client = createQueryClient()
  const save = client.getMutationCache().build(client, { mutationFn: () => Promise.reject(error) })
  await save.execute(undefined).catch(() => undefined)
}

describe("un guardado que la verificación en dos pasos rechaza", () => {
  beforeEach(() => toastError.mockClear())

  it("avisa y deja a la persona decidir cuándo seguir, sin perder lo escrito", async () => {
    await failingSave(asks("TWO_FACTOR_CODE_REQUIRED"))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ action: { label: "Verificar ahora" } })
  })

  it("no agrega nada a otros errores: los dice su formulario", async () => {
    await failingSave(new ApiError(400, { code: "VALIDATION", message: "Falta un dato" }))
    expect(toastError).not.toHaveBeenCalled()
  })
})
