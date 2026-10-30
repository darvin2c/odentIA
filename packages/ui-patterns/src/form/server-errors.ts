import type { AnyFormApi } from "@tanstack/react-form"
import * as React from "react"
import { fieldErrorMessages } from "./field-errors.js"

/**
 * Lo que dijo el último envío (el servidor o la validación al enviar) y que
 * debe seguir a la vista hasta que se corrija. TanStack Form borra los errores
 * de envío (`errorMap.onSubmit`) en cualquier validación que no sea de envío,
 * como salir de un campo: el aviso desaparecía aunque el dato siguiera mal, y
 * a veces bajo el puntero de quien iba a pulsar «Guardar». Por eso:
 * - el de un campo va a su `errorMap.onServer`, que TanStack no borra, y se
 *   quita en cuanto el campo cambia (`watchSubmitErrors`) o al volver a enviar;
 * - el general se guarda aquí con los valores enviados y se dice mientras no
 *   cambie ninguno.
 */
export interface SubmitErrors {
  /** Lo que no es de ningún campo: se dice junto a los botones. */
  form?: string | null
  /** Nombre del campo en el formulario → lo que se dice junto a él. */
  fields?: Record<string, string>
}

interface Kept {
  form: { message: string; values: unknown } | null
  /** Campo con error → el valor con que se envió. */
  fields: Map<string, unknown>
  listeners: Set<() => void>
}

/** `form` y `field.form` son objetos distintos que comparten su `store`. */
const kept = new WeakMap<object, Kept>()

function keptOf(form: AnyFormApi): Kept {
  let found = kept.get(form.store)
  if (!found) {
    found = { form: null, fields: new Map(), listeners: new Set() }
    kept.set(form.store, found)
  }
  return found
}

function setServerError(form: AnyFormApi, name: string, message: string | undefined): void {
  if (!form.getFieldMeta(name)) return
  form.setFieldMeta(name, (meta) => ({
    ...meta,
    // Lo de este envío reemplaza al aviso de la validación, que TanStack borraría al salir.
    errorMap: { ...meta.errorMap, onSubmit: message === undefined ? meta.errorMap.onSubmit : undefined, onServer: message },
  }))
}

function publish(state: Kept): void {
  for (const listener of state.listeners) listener()
}

/** Borra lo que dijo el envío anterior (al volver a enviar, al guardar bien). */
export function clearSubmitErrors(form: AnyFormApi): void {
  const state = keptOf(form)
  for (const name of state.fields.keys()) setServerError(form, name, undefined)
  state.fields.clear()
  if (state.form) {
    state.form = null
    publish(state)
  }
}

/** Dice el rechazo de un envío en el formulario (reemplaza lo anterior). */
export function setSubmitErrors(form: AnyFormApi, errors: SubmitErrors): void {
  clearSubmitErrors(form)
  const state = keptOf(form)
  for (const [name, message] of Object.entries(errors.fields ?? {})) {
    if (!message) continue
    setServerError(form, name, message)
    state.fields.set(name, form.getFieldValue(name))
  }
  state.form = errors.form ? { message: errors.form, values: form.state.values } : null
  publish(state)
}

/**
 * Lo que dejó en cada campo y en el formulario la validación al enviar: se
 * conserva igual que un rechazo del servidor. Con Zod (Standard Schema) el
 * error de un campo es una lista de issues.
 */
export function keepValidationErrors(form: AnyFormApi): void {
  const fields: Record<string, string> = {}
  for (const [name, info] of Object.entries(form.fieldInfo as Record<string, { instance: unknown } | undefined>)) {
    if (!info?.instance) continue
    const message = fieldErrorMessages([form.getFieldMeta(name)?.errorMap?.onSubmit].flat())[0]
    if (message) fields[name] = message
  }
  const formError = form.state.errorMap.onSubmit
  setSubmitErrors(form, { form: typeof formError === "string" ? formError : null, fields })
}

/**
 * Quita el error de un campo en cuanto cambia su valor (lo escriba la persona
 * o la pantalla). Devuelve cómo dejar de vigilar.
 */
export function watchSubmitErrors(form: AnyFormApi): () => void {
  const subscription = form.store.subscribe(() => {
    const state = keptOf(form)
    for (const [name, value] of state.fields) {
      if (Object.is(form.getFieldValue(name), value)) continue
      state.fields.delete(name)
      setServerError(form, name, undefined)
    }
  })
  return () => subscription.unsubscribe()
}

/** El error general del último envío mientras no cambie nada de lo enviado. */
export function useFormLevelSubmitError(form: AnyFormApi, values: unknown): string | null {
  const state = keptOf(form)
  const subscribe = React.useCallback(
    (listener: () => void) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    [state],
  )
  const kept = React.useSyncExternalStore(subscribe, () => state.form, () => state.form)
  return kept && kept.values === values ? kept.message : null
}
