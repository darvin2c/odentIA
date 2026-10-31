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
  /** Lista con filas con error → cuántas tenía al enviarse. */
  lists: Map<string, number>
  listeners: Set<() => void>
}

/** `form` y `field.form` son objetos distintos que comparten su `store`. */
const kept = new WeakMap<object, Kept>()

function keptOf(form: AnyFormApi): Kept {
  let found = kept.get(form.store)
  if (!found) {
    found = { form: null, fields: new Map(), lists: new Map(), listeners: new Set() }
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

/**
 * Borra lo que dijo el envío anterior (al volver a enviar, al guardar bien).
 * Con `which`, solo lo de esos campos (un autoguardado que mandó una parte)
 * y el aviso general se queda.
 */
export function clearSubmitErrors(form: AnyFormApi, which?: (name: string) => boolean): void {
  const state = keptOf(form)
  for (const name of [...state.fields.keys()]) {
    if (which && !which(name)) continue
    setServerError(form, name, undefined)
    state.fields.delete(name)
  }
  if (!which) state.lists.clear()
  if (!which && state.form) {
    state.form = null
    publish(state)
  }
}

/** El campo está en pantalla: TanStack conserva la meta de un campo desmontado o nunca montado. */
function isMounted(form: AnyFormApi, name: string): boolean {
  return Boolean((form.fieldInfo as Record<string, { instance: unknown } | undefined>)[name]?.instance)
}

/** Las listas que contienen al campo (`lines[1].price` → `lines`). */
function listsOf(name: string): string[] {
  return [...name.matchAll(/\[\d+\]/g)].map((match) => name.slice(0, match.index))
}

/**
 * Dice el rechazo de un envío en el formulario (reemplaza lo anterior). Lo de
 * un campo que el formulario no tiene registrado se dice junto a los botones:
 * ningún error se pierde.
 */
export function setSubmitErrors(form: AnyFormApi, errors: SubmitErrors): void {
  clearSubmitErrors(form)
  const state = keptOf(form)
  const unseen: string[] = []
  for (const [name, message] of Object.entries(errors.fields ?? {})) {
    if (!message) continue
    if (!isMounted(form, name)) {
      unseen.push(message)
      continue
    }
    setServerError(form, name, message)
    state.fields.set(name, form.getFieldValue(name))
    for (const list of listsOf(name)) {
      const rows = form.getFieldValue(list)
      if (Array.isArray(rows)) state.lists.set(list, rows.length)
    }
  }
  const general = [...new Set([errors.form, ...unseen].filter(Boolean))].join(" ")
  state.form = general ? { message: general, values: form.state.values } : null
  publish(state)
}

/**
 * Lo que dejó la validación al enviar: se conserva igual que un rechazo del
 * servidor. Con Zod (Standard Schema) el error de un campo es una lista de
 * issues. El de un dato que no tiene campo en pantalla (un paso que no está a
 * la vista, un esquema que valida de más) se dice junto a los botones: si no,
 * el envío se detendría sin decir por qué.
 */
export function keepValidationErrors(form: AnyFormApi): void {
  const fields: Record<string, string> = {}
  const unseen: string[] = []
  const metas = form.state.fieldMeta as Record<string, { errorMap?: { onSubmit?: unknown } } | undefined>
  for (const [name, meta] of Object.entries(metas)) {
    const message = fieldErrorMessages([meta?.errorMap?.onSubmit].flat())[0]
    if (!message) continue
    if (isMounted(form, name)) fields[name] = message
    else unseen.push(message)
  }
  const formError = form.state.errorMap.onSubmit
  const general = [...new Set([typeof formError === "string" ? formError : null, ...unseen].filter(Boolean))]
  setSubmitErrors(form, { form: general.join(" ") || null, fields })
}

/**
 * Quita el error de un campo en cuanto cambia su valor (lo escriba la persona
 * o la pantalla). Devuelve cómo dejar de vigilar.
 *
 * Al quitar o agregar una fila, TanStack cambia los valores y después mueve la
 * meta de las filas: se mira en una microtarea, ya movido, y los errores de esa
 * lista se borran porque ya no se sabe de qué fila son (el próximo envío los
 * vuelve a decir).
 */
export function watchSubmitErrors(form: AnyFormApi): () => void {
  let queued = false
  let stopped = false
  const check = () => {
    queued = false
    if (stopped) return
    const state = keptOf(form)
    for (const [list, length] of state.lists) {
      const rows = form.getFieldValue(list)
      if (Array.isArray(rows) && rows.length === length) continue
      state.lists.delete(list)
      const prefix = `${list}[`
      for (const name of state.fields.keys()) if (name.startsWith(prefix)) state.fields.delete(name)
      for (const name of Object.keys(form.state.fieldMeta)) if (name.startsWith(prefix)) setServerError(form, name, undefined)
    }
    for (const [name, value] of state.fields) {
      if (Object.is(form.getFieldValue(name), value)) continue
      state.fields.delete(name)
      setServerError(form, name, undefined)
    }
  }
  const subscription = form.store.subscribe(() => {
    if (queued) return
    queued = true
    queueMicrotask(check)
  })
  return () => {
    stopped = true
    subscription.unsubscribe()
  }
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
