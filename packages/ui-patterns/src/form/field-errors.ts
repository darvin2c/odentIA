/**
 * Normaliza errores de campo de TanStack Form a mensajes mostrables.
 * Con validadores Zod (Standard Schema) son objetos `{ message, path, ... }`,
 * no strings: interpolarlos directo pinta "[object Object]".
 */
export function fieldErrorMessages(errors: unknown): string[] {
  if (!Array.isArray(errors)) return []
  const messages: string[] = []
  for (const error of errors) {
    if (typeof error === "string") {
      if (error) messages.push(error)
    } else if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      messages.push(error.message)
    }
  }
  return messages
}
