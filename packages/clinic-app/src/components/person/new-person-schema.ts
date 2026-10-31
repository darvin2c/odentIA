import { validateDemographics } from "@odentia/clinical"
import type { z } from "zod"

/**
 * Una persona nueva con las reglas de `createPerson` (POST `/api/people`):
 * nombres y apellidos obligatorios y el teléfono y el correo con el formato
 * que exige la ficha (`validateDemographics`), cada uno dicho en su campo
 * antes de enviar. Los datos se llaman como en el cuerpo de la petición: lo
 * que rechace el servidor cae en el mismo campo. Los máximos los ponen los
 * propios campos (`maxLength`).
 */
export function refineNewPerson(
  value: { givenNames: string; familyName: string; phone: string | null; email?: string },
  ctx: z.RefinementCtx,
  countryCode: string | null | undefined,
): void {
  const givenNames = value.givenNames.trim()
  const familyName = value.familyName.trim()
  if (!givenNames) ctx.addIssue({ code: "custom", path: ["givenNames"], message: "Escribe los nombres" })
  if (!familyName) ctx.addIssue({ code: "custom", path: ["familyName"], message: "Escribe los apellidos" })
  if (!givenNames || !familyName) return
  const errors = validateDemographics(
    {
      displayName: `${givenNames} ${familyName}`,
      givenNames,
      familyName,
      phone: value.phone,
      email: value.email?.trim() || null,
    },
    undefined,
    countryCode,
  )
  // El nombre completo que pasa de 200 caracteres se dice en los apellidos, donde se acorta.
  if (errors.displayName) ctx.addIssue({ code: "custom", path: ["familyName"], message: errors.displayName })
  for (const key of ["phone", "email"] as const) {
    const message = errors[key]
    if (message) ctx.addIssue({ code: "custom", path: [key], message })
  }
}
