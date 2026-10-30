// Mecánica común de los formularios de la web con TanStack Form (la web no usa `@odentia/ui-patterns`):
// el error de cada campo, el rechazo de la API pública repartido por campo y el foco al primero marcado.
import type { AnyFormApi } from "@tanstack/react-form"

/** La misma expresión que `z.email()` de zod 4, con la que valida el servidor. */
export const EMAIL =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

/** Teléfono como lo acepta el servidor: «+51 987 654 321», «(01) 555-1234». */
export const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/

/** Rechazo del envío: el aviso general y, en `fields`, lo que la API dijo de cada dato (su nombre en el cuerpo). */
export class SubmitRejected extends Error {
  readonly fields: Record<string, string>
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message)
    this.name = "SubmitRejected"
    this.fields = fields
  }
}

/** Lee `{ error: { code, message, fields } }` de la API pública; `fallback` si no trae mensaje. */
export function rejectionOf(body: unknown, fallback: string): SubmitRejected {
  const error =
    body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object"
      ? (body.error as { message?: unknown; fields?: unknown })
      : null
  const message =
    typeof error?.message === "string" && error.message.trim() ? error.message.trim() : fallback
  const fields: Record<string, string> = {}
  if (error?.fields && typeof error.fields === "object") {
    for (const [key, text] of Object.entries(error.fields)) {
      if (typeof text === "string" && text.trim()) fields[key] = text.trim()
    }
  }
  return new SubmitRejected(message, fields)
}

/**
 * Pone el rechazo en el formulario: cada dato señalado, en su campo si está en pantalla (`fieldMap` traduce
 * el nombre del cuerpo al del formulario cuando difieren). Devuelve el aviso general: lo que no cayó en
 * ningún campo, o nada si todo quedó junto a su campo. Cada error se borra al corregir su campo.
 */
export function applyRejection(
  form: AnyFormApi,
  error: unknown,
  fallback: string,
  fieldMap: Record<string, string> = {},
): string | null {
  if (!(error instanceof SubmitRejected)) return fallback
  const mounted = new Set(
    Object.entries(form.fieldInfo as Record<string, { instance: unknown } | undefined>)
      .filter(([, info]) => info?.instance)
      .map(([name]) => name),
  )
  const own: Record<string, string> = {}
  const rest: string[] = []
  for (const [key, text] of Object.entries(error.fields)) {
    const name = fieldMap[key] ?? key
    if (mounted.has(name)) own[name] ??= text
    else rest.push(text)
  }
  form.setErrorMap({ onSubmit: { form: undefined, fields: own } })
  if (Object.keys(error.fields).length === 0) return error.message
  return rest.length > 0 ? [...new Set(rest)].join(" ") : null
}

/** Borra lo que dijo el servidor en el envío anterior: el nuevo envío vuelve a validar. */
export function clearRejection(form: AnyFormApi): void {
  form.setErrorMap({ onSubmit: { form: undefined, fields: {} } })
}

/** El primer error de un campo, si lo tiene. */
export function fieldError(meta: { errors: readonly unknown[] } | undefined): string | undefined {
  const found = meta?.errors.find((error) => typeof error === "string" && error)
  return typeof found === "string" ? found : undefined
}

/**
 * Lleva el foco al primer campo marcado (`aria-invalid="true"`) en el orden de la página, cuando React ya
 * pintó los errores del envío.
 */
export function focusFirstInvalid(root: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const scope: ParentNode = root?.isConnected ? root : document
    const target = scope.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (!target) return
    target.focus()
    target.scrollIntoView({ block: "center" })
  })
}
