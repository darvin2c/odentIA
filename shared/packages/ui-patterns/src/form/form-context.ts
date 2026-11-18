import { createFormHookContexts } from "@tanstack/react-form"

/**
 * Contextos del formulario de la interfaz (`useAppForm`): los campos de
 * `form/fields.tsx` leen su campo de aquí, sin que la pantalla se lo pase.
 */
export const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()
