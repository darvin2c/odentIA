import { z } from "zod"

export const portalScopeInput = z.strictObject({
  appointments: z.boolean().optional(), budgets: z.boolean().optional(),
  account: z.boolean().optional(), documentIds: z.array(z.uuid()).max(100).optional(),
})
/** Lo único que se configura del portal: encendido y lo que el paciente puede ver (ADR 0037). */
export const portalPolicyInput = z.strictObject({
  enabled: z.boolean(),
  allowedScope: z.strictObject({ appointments: z.boolean(), budgets: z.boolean(), account: z.boolean(), documents: z.boolean() }),
})
/** «Dar acceso al portal» en un paso: quién entra, qué verá, la comprobación y cómo le llega. */
export const portalAccessInput = z.strictObject({
  patientId: z.uuid(),
  contactId: z.uuid(),
  scope: portalScopeInput,
  identityChecked: z.boolean(),
  delivery: z.enum(["qr", "whatsapp"]),
})
export const portalIdInput = z.strictObject({ id: z.uuid() })
export const portalSlugInput = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
