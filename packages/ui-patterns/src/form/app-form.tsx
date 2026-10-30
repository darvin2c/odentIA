import { type AnyFormApi, createFormHook, evaluate, useStore } from "@tanstack/react-form"
import * as React from "react"
import {
  CheckboxField,
  ControlField,
  GroupField,
  PasswordField,
  PhoneField,
  RadioGroupField,
  SelectField,
  TextareaField,
  TextField,
} from "./fields.js"
import { fieldContext, formContext } from "./form-context.js"
import {
  clearSubmitErrors,
  keepValidationErrors,
  setSubmitErrors,
  useFormLevelSubmitError,
  watchSubmitErrors,
} from "./server-errors.js"
import { submitErrorOf } from "./submit-error.js"

const appForm = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    TextareaField,
    SelectField,
    CheckboxField,
    RadioGroupField,
    PhoneField,
    PasswordField,
    Control: ControlField,
    Group: GroupField,
  },
  formComponents: {},
})

export const { withForm, withFieldGroup, useTypedAppFormContext, extendForm } = appForm

/** Lo que dejó el último `form.reset(values)` y los `defaultValues` que recibía entonces el hook. */
interface KeptReset {
  passed: unknown
  values: unknown
}

const keepingResets = new WeakSet<object>()

/**
 * El formulario de la interfaz: TanStack Form con los campos ya unidos a su
 * etiqueta, su ayuda y su error (`form.AppField` → `field.TextField`…).
 *
 * ```tsx
 * const form = useAppForm({
 *   defaultValues,
 *   validators: { onSubmit: schema },
 *   onSubmit: async ({ value }) => { await save.mutateAsync(value) },
 * })
 * const surface = useFormSurface(form)
 * <FormDrawer {...surface} open title="…" onClose={onClose}>
 *   <form.AppField name="name">{(field) => <field.TextField label="Nombre" />}</form.AppField>
 * </FormDrawer>
 * ```
 *
 * Si el servidor rechaza el envío, cada dato que señala (`fields`) se dice en
 * su campo y lo demás junto a los botones: `onSubmit` solo tiene que lanzar
 * el error (`mutateAsync`), sin toast ni aviso propio.
 *
 * `form.reset(values)` deja `values` como lo guardado hasta que cambien de
 * verdad los `defaultValues` que recibe el hook. TanStack Form (1.33) vuelve
 * a aplicar en cada render esos `defaultValues` sobre lo que dejó el `reset`
 * si el formulario no se tocó: abrir un dato para corregirlo mostraba el
 * campo vacío.
 */
export const useAppForm: typeof appForm.useAppForm = (props) => {
  const passed = React.useRef<unknown>(props.defaultValues)
  passed.current = props.defaultValues
  const kept = React.useRef<KeptReset | null>(null)
  if (kept.current && !evaluate(props.defaultValues, kept.current.passed)) kept.current = null
  const self = React.useRef<AnyFormApi | null>(null)
  const onSubmit = props.onSubmit
  const form = appForm.useAppForm({
    ...props,
    ...(kept.current ? { defaultValues: kept.current.values as typeof props.defaultValues } : {}),
    // TanStack le pasa a `onSubmit` su objeto interno, sin el `reset` de abajo: recibe este.
    ...(onSubmit
      ? {
          onSubmit: (args: Parameters<typeof onSubmit>[0]) =>
            onSubmit({ ...args, formApi: (self.current ?? args.formApi) as typeof args.formApi }),
        }
      : {}),
  })
  self.current = form
  if (!keepingResets.has(form)) {
    keepingResets.add(form)
    const reset = form.reset
    form.reset = (values, options) => {
      if (values !== undefined && !options?.keepDefaultValues) kept.current = { passed: passed.current, values }
      reset(values, options)
    }
  }
  React.useEffect(() => watchSubmitErrors(form), [form])
  return form
}

/**
 * Cómo se llama en el formulario un dato que el servidor señala por su nombre
 * en el cuerpo (`answers.demographics.familyName` → `surnames`). Lo que no se
 * nombra conserva su nombre; lo que no tiene campo en pantalla se dice junto a
 * los botones.
 */
export type ServerFieldMap = Record<string, string> | ((serverField: string) => string | undefined)

export interface SubmitOptions {
  fieldMap?: ServerFieldMap
  /**
   * Palabras propias de la pantalla para un rechazo que no es de ningún campo
   * (los códigos de caja, por ejemplo). `null`/`undefined`: lo de siempre.
   */
  formMessage?: (error: unknown) => string | null | undefined
}

function formFieldName(map: ServerFieldMap | undefined, key: string): string {
  if (!map) return key
  if (typeof map === "function") return map(key) ?? key
  return map[key] ?? key
}

/**
 * Pone el rechazo del servidor en el formulario: cada dato señalado en su
 * campo (si está en pantalla) y el resto, con el mensaje general, junto a los
 * botones. Cada uno se va al corregir su campo; todo, al volver a enviar.
 */
export function applySubmitError(form: AnyFormApi, error: unknown, options: SubmitOptions = {}): void {
  const base = submitErrorOf(error)
  const fields = base.fields
  const message = base.form === null ? null : (options.formMessage?.(error) ?? base.form)
  const mounted = new Set(
    Object.entries(form.fieldInfo as Record<string, { instance: unknown } | undefined>)
      .filter(([, info]) => info?.instance)
      .map(([name]) => name),
  )
  const own: Record<string, string> = {}
  const rest: string[] = []
  for (const [key, text] of Object.entries(fields)) {
    const name = formFieldName(options.fieldMap, key)
    if (mounted.has(name)) own[name] ??= text
    else rest.push(text)
  }
  const formMessage = [...new Set([message, ...rest].filter((text): text is string => !!text))].join(" ")
  setSubmitErrors(form, { form: formMessage || null, fields: own })
}

/** El error general del envío (lo que no es de ningún campo), o nada; se actualiza solo. */
export function useFormSubmitError(form: AnyFormApi): string | null {
  const values = useStore(form.store, (state) => state.values)
  return useFormLevelSubmitError(form, values)
}

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]'

/**
 * Lleva el foco al primer campo marcado: tras un envío que no pasó, quien
 * guarda llega directo a lo que hay que corregir (también desde el pie fijo
 * de un formulario largo). Un grupo marcado (opciones, chips: el `fieldset` de
 * `field.Group` con `data-invalid`) recibe el foco en su primera opción.
 */
export function focusFirstInvalid(root: ParentNode | null): void {
  const run = () => {
    const scope: ParentNode = root && (root as Node).isConnected ? root : document
    for (const marked of scope.querySelectorAll<HTMLElement>('[aria-invalid="true"], fieldset[data-invalid="true"]')) {
      // Con `tabindex` (también -1: la firma, la persona elegida) se enfoca él; si no, su primer control.
      const target =
        marked.matches(FOCUSABLE) || marked.hasAttribute("tabindex") ? marked : marked.querySelector<HTMLElement>(FOCUSABLE)
      if (!target) continue
      target.focus({ preventScroll: false })
      target.scrollIntoView?.({ block: "center" })
      return
    }
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
  else run()
}

/**
 * Envía el formulario: borra lo que dijo el envío anterior, valida, llama a
 * `onSubmit` y, si este lanza, pone el rechazo en sus campos. Nunca deja una
 * promesa rechazada sin atender.
 */
export async function submitForm(
  form: AnyFormApi,
  options: SubmitOptions & { root?: ParentNode | null } = {},
): Promise<boolean> {
  clearSubmitErrors(form)
  let rejected = false
  try {
    await form.handleSubmit()
  } catch (error) {
    rejected = true
    applySubmitError(form, error, options)
  }
  const ok = form.state.isSubmitSuccessful
  if (!ok) {
    if (!rejected) keepValidationErrors(form)
    focusFirstInvalid(options.root ?? null)
  }
  return ok
}

/** `onSubmit` de un `<form>` propio para `useAppForm`: cancela el envío nativo y usa `submitForm`. */
export function useFormSubmit(form: AnyFormApi, options: SubmitOptions = {}): (event?: React.FormEvent) => void {
  const latest = React.useRef(options)
  latest.current = options
  return React.useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault()
      event?.stopPropagation()
      const root = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
      void submitForm(form, { ...latest.current, root })
    },
    [form],
  )
}

/** Lo que `FormDrawer`/`FormPanel` necesitan de un `useAppForm`. */
export interface FormSurfaceBinding {
  onSubmit: (event: React.FormEvent) => void
  isSubmitting: boolean
  isDirty: boolean
  error: string | null
}

/**
 * Une un `useAppForm` a `FormDrawer`/`FormPanel` (`{...useFormSurface(form)}`):
 * envío, «guardando», cambios sin guardar y el error que no es de ningún campo,
 * que la superficie dice junto a sus botones.
 */
export function useFormSurface(form: AnyFormApi, options: SubmitOptions = {}): FormSurfaceBinding {
  const onSubmit = useFormSubmit(form, options)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const isDirty = useStore(form.store, (state) => state.isDirty)
  const error = useFormSubmitError(form)
  return { onSubmit, isSubmitting, isDirty, error }
}
