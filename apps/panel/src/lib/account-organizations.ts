import { queryOptions } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "./api"

const provisioningSchema = z.object({ hasProfile: z.boolean(), hasBranch: z.boolean() })
const organizationSchema = z.object({
  organizationId: z.string(), organizationName: z.string(), slug: z.string(),
  logo: z.string().nullable(),
  role: z.string(), roleLabel: z.string(), canLeave: z.boolean(), provisioning: provisioningSchema,
})
const invitationSchema = z.object({
  id: z.string(), organizationId: z.string(), organizationName: z.string(), slug: z.string(),
  role: z.string().nullable(), roleLabel: z.string(), expiresAt: z.string(), provisioning: provisioningSchema,
})
export type AccountOrganization = z.infer<typeof organizationSchema>
export type AccountInvitation = z.infer<typeof invitationSchema>

export const accountOrganizationsQuery = queryOptions({
  queryKey: ["account", "organizations"],
  queryFn: async () => z.object({ data: z.array(organizationSchema) }).parse(await apiFetch<unknown>("/api/account/organizations")).data,
})
export const accountInvitationsQuery = queryOptions({
  queryKey: ["account", "invitations"],
  queryFn: async () => z.object({ data: z.array(invitationSchema) }).parse(await apiFetch<unknown>("/api/account/invitations/pending")).data,
})

export const billingStatusSchema = z.object({
  status: z.enum(["prueba", "activa", "gracia", "restringida", "pausada", "cancelada", "sin_suscripcion"]),
  isDemo: z.boolean(), restricted: z.boolean(), restrictReason: z.string().nullable(),
  pauseReason: z.string().nullable(), trialEndsAt: z.string().nullable(), graceEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(), planCode: z.string().nullable(), planName: z.string().nullable(), currency: z.string().nullable(),
})
export type AccountBillingStatus = z.infer<typeof billingStatusSchema>
