import type { AnyFormApi } from "@tanstack/react-form"

/**
 * Lo que devuelve el validador `onSubmit` de un `useAppForm` cuando la regla es
 * compartida con el servidor (`validateRegistrationAnswers`,
 * `validateDemographics`) y devuelve un mapa dato → mensaje: cada mensaje va a
 * su campo si está en pantalla y el resto, junto a los botones. Un error en un
 * campo que no se ve bloquearía el envío sin decir nada.
 */
export function placeErrors(
  formApi: AnyFormApi,
  errors: Record<string, string>,
): { form?: string; fields: Record<string, string> } | undefined {
  const fields: Record<string, string> = {}
  const rest: string[] = []
  for (const [name, message] of Object.entries(errors)) {
    const info = (formApi.fieldInfo as Record<string, { instance: unknown } | undefined>)[name]
    if (info?.instance) fields[name] ??= message
    else rest.push(message)
  }
  if (Object.keys(fields).length === 0 && rest.length === 0) return undefined
  return { ...(rest.length ? { form: [...new Set(rest)].join(" ") } : {}), fields }
}
