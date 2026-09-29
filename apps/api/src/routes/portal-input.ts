import { z } from "zod"

export const portalScopeInput = z.strictObject({
  appointments: z.boolean().optional(), budgets: z.boolean().optional(),
  account: z.boolean().optional(), documentIds: z.array(z.uuid()).max(100).optional(),
})
export const portalGrantInput = z.strictObject({
  patientId: z.uuid(), contactId: z.uuid(),
  relationship: z.enum(["self", "guardian", "family", "other"]).optional(),
  scope: portalScopeInput,
  verifiedMethod: z.enum(["presencial_documento", "representacion_verificada"]),
  evidenceNote: z.string().trim().min(1).max(1000).optional(),
})
export const portalPolicyInput = z.strictObject({
  enabled: z.boolean(), requestsEnabled: z.boolean(), publicRequestsEnabled: z.boolean(),
  channelRequestsEnabled: z.boolean(), autoApproveVerified: z.boolean(),
  allowedConnectionIds: z.array(z.uuid()).max(50),
  linkTtlMinutes: z.number().int().min(1).max(43200),
  sessionTtlHours: z.number().int().min(1).max(168),
  grantTtlDays: z.number().int().min(1).max(3650).nullable(),
  allowedScope: z.strictObject({ appointments: z.boolean(), budgets: z.boolean(), account: z.boolean(), documents: z.boolean() }),
  passkeysEnabled: z.boolean(), assistedRecoveryEnabled: z.boolean(),
})
export const portalIdInput = z.strictObject({ id: z.uuid() })
export const portalSlugInput = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
