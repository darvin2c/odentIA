/**
 * La cuenta de un cliente que ya entró, como la lee la ficha de la clínica
 * (`/api/admin/organizations/:id`). Se pide con la misma clave que esa ficha
 * porque `OrgSummary` la lee de la caché para saber si es una demo; el esquema
 * deja pasar los demás campos para no recortarle nada a quien la comparte.
 */
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../../lib/api"

export const organizationAccountSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  invitations: z.array(
    z.looseObject({
      id: z.string(),
      email: z.string(),
      role: z.string().nullable(),
      status: z.string(),
      expiresAt: z.string(),
    }),
  ),
  usage: z.looseObject({
    members: z.number(),
    branches: z.number(),
    patients: z.number(),
    contacts: z.number(),
    pendingInvitations: z.number(),
  }),
  billing: z
    .looseObject({
      status: z.string(),
      restricted: z.boolean(),
      isDemo: z.boolean(),
      plan: z.object({ name: z.string() }).nullable(),
    })
    .nullable(),
})
export type OrganizationAccount = z.infer<typeof organizationAccountSchema>

export const organizationAccountKey = (organizationId: string) =>
  ["admin-organization", organizationId] as const

export function useOrganizationAccount(organizationId: string | null) {
  return useQuery({
    queryKey: organizationAccountKey(organizationId ?? ""),
    enabled: organizationId !== null,
    queryFn: async () =>
      organizationAccountSchema.parse(
        await api<unknown>(`/api/admin/organizations/${organizationId}`),
      ),
  })
}
