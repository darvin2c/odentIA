import { toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { ApiError } from "../../lib/api"

/** El servidor dice que la hora choca con otra presentación de quien presenta o con su ausencia. */
export function isSlotClash(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.shape.code === "SLOT_TAKEN"
}

/**
 * Agendar o mover una presentación que choca: se avisa con el porqué y la persona decide
 * («Agendar igual» o «Mover igual» la vuelve a enviar con `force`). El aviso no traba: queda
 * abierto hasta que lo elige o lo cierra, y el servidor guarda la constancia de que se vio.
 * Kairós nunca pasa por aquí: él solo ofrece horas libres. Otro error sigue su camino.
 */
export async function withClashChoice(
  send: () => Promise<void>,
  label: string,
  sendAnyway: () => Promise<void>,
): Promise<void> {
  try {
    await send()
  } catch (error) {
    if (!isSlotClash(error)) throw error
    const id = toast.warning(error.shape.message ?? "Esa hora choca con otra presentación.", {
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      action: {
        label,
        onClick: () => {
          toast.dismiss(id)
          sendAnyway().catch((again: unknown) => toast.error(submitErrorMessage(again)))
        },
      },
    })
  }
}
