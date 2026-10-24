import { queryOptions } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "./api"

const provisioningSchema = z.object({ hasProfile: z.boolean(), hasBranch: z.boolean() })
const organizationSchema = z.object({
  organizationId: z.string(), organizationName: z.string(), slug: z.string(),
  logo: z.string().nullable(), branches: z.array(z.string()),
  role: z.string(), roleLabel: z.string(), canLeave: z.boolean(), provisioning: provisioningSchema,
  // El producto de la clínica: abre en su dominio (decisión 9 del issue 229).
  product: z.string(),
})
const invitationSchema = z.object({
  id: z.string(), organizationId: z.string(), organizationName: z.string(), slug: z.string(),
  role: z.string().nullable(), roleLabel: z.string(), expiresAt: z.string(), provisioning: provisioningSchema,
  product: z.string(),
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

/** El aviso de la franja (ADR 0065) que decide el servidor para quien mira; el selector usa el más grave de cobro. */
export const clinicNoticeSchema = z.object({
  id: z.string(),
  topic: z.enum(["cobro", "tope", "plan", "soporte"]),
  tone: z.enum(["aviso", "alarma", "limite"]),
  message: z.string(),
  short: z.string(),
  action: z.object({ kind: z.string(), label: z.string(), shortLabel: z.string() }).passthrough().nullable(),
  dismiss: z.enum(["nivel", "dia"]).nullable(),
})
export type ClinicNotice = z.infer<typeof clinicNoticeSchema>
