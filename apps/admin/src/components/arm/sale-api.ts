/**
 * Lo que la venta del ARM lee de la API (`/api/admin/clients`, rutas de
 * `apps/api/src/routes/admin-clients.ts`): cada respuesta se lee con zod y cada
 * lectura tiene su clave de caché. Las claves cuelgan de `["admin","client",id]`
 * y una mutación las refresca todas a la vez. La ficha misma se lee una sola
 * vez, con el esquema de `client-model.ts`: la venta la recorta con `select`.
 */
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { type ClientDetail, invalidateClient } from "./client-model"
import { clientQueryKeys, fetchClientDetail } from "./client-queries"
import { CLIENT_STAGES, PROPOSAL_STATUSES } from "./sale-words"

export const productShape = z.enum(CLINICAL_PRODUCTS)
const person = z.object({ userId: z.string(), name: z.string() })

export const contactSchema = z.object({
  /** Null en un miembro de la cuenta que todavía no es contacto. */
  id: z.string().nullable(),
  name: z.string(),
  title: z.string().nullable(),
  roles: z.array(z.string()),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  isPrimary: z.boolean(),
  readOnly: z.boolean(),
})
export type SaleContact = z.infer<typeof contactSchema>

export const clientSaleSchema = z.object({
  id: z.string(),
  name: z.string(),
  product: productShape,
  stage: z.enum(CLIENT_STAGES),
  countryCode: z.string(),
  city: z.string().nullable(),
  professionals: z.string().nullable(),
  currentTool: z.string().nullable(),
  owner: person.nullable(),
  organization: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      planStatus: z.string().nullable(),
    })
    .nullable(),
  nextStep: z
    .object({
      taskId: z.string(),
      kind: z.string(),
      title: z.string(),
      dueOn: z.string(),
      dueAt: z.string().nullable(),
      overdue: z.boolean(),
    })
    .nullable(),
  opportunity: z
    .object({
      id: z.string(),
      seller: z.object({ id: z.string(), name: z.string() }).nullable(),
      expectedOn: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  waitlistRequest: z
    .object({
      id: z.string(),
      status: z.string(),
      stage: z.string(),
      source: z.string(),
      email: z.string(),
      createdAt: z.string(),
      invitedAt: z.string().nullable(),
      inviteExpiresAt: z.string().nullable(),
      enteredAt: z.string().nullable(),
    })
    .nullable(),
  contacts: z.array(contactSchema),
})
export type ClientSale = z.infer<typeof clientSaleSchema>

export const taskSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  kind: z.string(),
  title: z.string(),
  dueOn: z.string(),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  assignee: person.nullable(),
  contactId: z.string().nullable(),
  demoId: z.string().nullable(),
  status: z.enum(["abierta", "hecha", "cancelada"]),
  byKairos: z.boolean(),
  doneAt: z.string().nullable(),
  doneNote: z.string().nullable(),
})
export type SaleTask = z.infer<typeof taskSchema>

export const proposalSchema = z.object({
  id: z.string(),
  version: z.number(),
  plan: z.object({
    id: z.string(),
    name: z.string(),
    priceCents: z.number(),
    creditCents: z.number(),
  }),
  listPriceCents: z.number(),
  currency: z.string(),
  discountBps: z.number(),
  discountMonths: z.number().nullable(),
  trialDays: z.number().nullable(),
  trialCreditCents: z.number().nullable(),
  billingCycle: z.enum(["mensual", "quincenal"]),
  validUntil: z.string(),
  status: z.enum(["borrador", "por_aprobar", "enviada", "aceptada", "no_aceptada"]),
  displayStatus: z.enum(PROPOSAL_STATUSES),
  sentAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  acceptedNote: z.string().nullable(),
  createdAt: z.string(),
})
export type SaleProposal = z.infer<typeof proposalSchema>

export const timelineSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      who: z.object({
        kind: z.enum(["persona", "kairos", "sistema", "clinica"]),
        name: z.string(),
      }),
      category: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      adminOnly: z.boolean(),
    }),
  ),
  nextBefore: z.string().nullable(),
})
export type SaleTimelineEntry = z.infer<typeof timelineSchema>["items"][number]

export const outreachSchema = z.object({
  id: z.string(),
  channel: z.enum(["correo", "whatsapp"]),
  to: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  proposalId: z.string().nullable(),
  status: z.enum(["pendiente", "enviado", "incierto", "no_salio"]),
  whatsappUrl: z.string().nullable(),
})
export type SaleOutreach = z.infer<typeof outreachSchema>

/** Lo que la solicitud de la web dice de sí misma (`/api/admin/waitlist/:id`, la misma de la lista de espera). */
export const requestDetailSchema = z.object({
  request: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string(),
    city: z.string(),
    professionals: z.string(),
    currentTool: z.string(),
    status: z.string(),
    stage: z.string(),
    planName: z.string().nullable(),
    discardReason: z.string().nullable(),
    createdAt: z.string(),
    answer: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("por_responder"),
          due: z.enum(["vencida", "hoy", "hasta"]),
          by: z.string(),
          day: z.string(),
        }),
        z.object({ kind: z.literal("contactada"), day: z.string() }),
        z.object({ kind: z.literal("volver"), day: z.string() }),
      ])
      .nullable(),
    nextFollowUpOn: z.string().nullable(),
  }),
  entries: z.array(
    z.object({
      id: z.string(),
      authorName: z.string().nullable(),
      body: z.string().nullable(),
      followUpOn: z.string().nullable(),
      adminOnly: z.boolean(),
      fromNote: z.boolean().default(false),
      createdAt: z.string(),
    }),
  ),
})
export type RequestDetail = z.infer<typeof requestDetailSchema>

export const planSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  product: productShape,
  currency: z.string(),
  priceCents: z.number(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  maxDiscountBps: z.number(),
  sellerDiscountBps: z.number(),
  trialDays: z.number(),
  trialMaxDays: z.number(),
  trialCreditCents: z.number(),
  trialMaxCreditCents: z.number(),
})
export type SalePlan = z.infer<typeof planSchema>

const sellerSchema = z.object({ id: z.string(), displayName: z.string() })

/* ---------- Claves de caché ---------- */

export const saleKeys = {
  tasks: (clientId: string, status: "abierta" | "hecha") =>
    ["admin", "client", clientId, "venta", "tareas", status] as const,
  proposals: (clientId: string) => ["admin", "client", clientId, "venta", "propuestas"] as const,
  timeline: (clientId: string) => ["admin", "client", clientId, "venta", "historial"] as const,
  request: (clientId: string, requestId: string) =>
    ["admin", "client", clientId, "venta", "solicitud", requestId] as const,
  plans: ["admin", "billing", "plans", "arm"] as const,
  sellers: ["admin", "billing", "sellers", "arm"] as const,
}

/** Lo que refresca cualquier cambio de la venta: el mismo de toda la ficha. */
export { invalidateClient }

export function useInvalidateClient(clientId: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => invalidateClient(queryClient, clientId), [queryClient, clientId])
}

/* ---------- Lecturas ---------- */

const enc = encodeURIComponent

/** Lo que la venta lee de la ficha, con las etapas y los campos que usa. */
const saleOf = (detail: ClientDetail): ClientSale => clientSaleSchema.parse(detail)

/**
 * La ficha vista desde la venta: la misma petición y la misma clave que
 * `useClientDetail` (una sola lectura por ficha, con el esquema de
 * `client-model.ts`), recortada a lo que usan la pestaña y los cajones.
 */
export function useClientSale(clientId: string, enabled = true) {
  return useQuery({
    queryKey: clientQueryKeys.detail(clientId),
    enabled,
    queryFn: () => fetchClientDetail(clientId),
    select: saleOf,
  })
}

export function useClientTasks(clientId: string, status: "abierta" | "hecha", enabled = true) {
  return useQuery({
    queryKey: saleKeys.tasks(clientId, status),
    enabled,
    queryFn: async () =>
      z
        .array(taskSchema)
        .parse(
          await api<unknown>(`/api/admin/clients/tasks?clientId=${enc(clientId)}&status=${status}`),
        ),
  })
}

/** Las propuestas llevan importes: solo Administración (el servidor responde 403 a Soporte). */
export function useClientProposals(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: saleKeys.proposals(clientId),
    enabled,
    queryFn: async () =>
      z
        .array(proposalSchema)
        .parse(await api<unknown>(`/api/admin/clients/${enc(clientId)}/proposals`)),
  })
}

export function useSaleTimeline(clientId: string, enabled = true) {
  return useQuery({
    queryKey: saleKeys.timeline(clientId),
    enabled,
    queryFn: async () =>
      timelineSchema.parse(
        await api<unknown>(`/api/admin/clients/${enc(clientId)}/timeline?filter=venta&limit=100`),
      ),
  })
}

export function useRequestDetail(clientId: string, requestId: string | null) {
  return useQuery({
    queryKey: saleKeys.request(clientId, requestId ?? "-"),
    enabled: requestId !== null,
    queryFn: async () =>
      requestDetailSchema.parse(await api<unknown>(`/api/admin/waitlist/${enc(requestId ?? "")}`)),
  })
}

/** Los planes con su id y sus topes (solo Administración). */
export function usePlans(enabled: boolean) {
  return useQuery({
    queryKey: saleKeys.plans,
    enabled,
    staleTime: 60_000,
    queryFn: async () => z.array(planSchema).parse(await api<unknown>("/api/admin/billing/plans")),
  })
}

/** Quién vende (solo Administración). */
export function useSellers(enabled: boolean) {
  return useQuery({
    queryKey: saleKeys.sellers,
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      z.array(sellerSchema).parse(await api<unknown>("/api/admin/billing/sellers")),
  })
}

/* ---------- Escrituras ---------- */

export const postJson = <T = unknown>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) })

/** «No se sabe si salió»: el correo quedó incierto y no se repite solo; lo resuelve una persona. */
export class SendUnknownError extends Error {
  constructor(
    public outreachId: string | null,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Escribir (`POST /:id/outreach`). Correo: `{outreach, url: null}`. WhatsApp:
 * `{outreach, url}` con el enlace. El rechazo 502 `SEND_UNKNOWN` trae el id del
 * envío incierto (`details.outreachId` del `ApiError`): con él la persona marca
 * «Salió» o «No salió» sin volver a enviar.
 */
export async function sendOutreach(
  clientId: string,
  body: unknown,
): Promise<{ outreach: SaleOutreach; url: string | null }> {
  try {
    return z
      .object({ outreach: outreachSchema, url: z.string().nullable() })
      .parse(await postJson(`/api/admin/clients/${enc(clientId)}/outreach`, body))
  } catch (error) {
    if (error instanceof ApiError && error.shape.code === "SEND_UNKNOWN") {
      const outreachId =
        typeof error.details.outreachId === "string" ? error.details.outreachId : null
      throw new SendUnknownError(outreachId, error.shape.message ?? "No se sabe si el correo salió")
    }
    throw error
  }
}

export async function resolveOutreach(outreachId: string, outcome: "salio" | "no_salio") {
  return postJson(`/api/admin/clients/outreach/${enc(outreachId)}/resolve`, { outcome })
}

/** El PDF de una propuesta, como dirección de la memoria de la pestaña (quien la pide la suelta). */
export async function proposalPdfUrl(proposalId: string): Promise<string> {
  // El PDF no viene en `{data}`: se pide aparte, con la misma cookie.
  const response = await fetch(`${API_URL}/api/admin/clients/proposals/${enc(proposalId)}/pdf`, {
    credentials: "include",
  })
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
      })
      .safeParse(await response.json().catch(() => ({})))
    throw new ApiError(response.status, parsed.success ? (parsed.data.error ?? {}) : {})
  }
  return URL.createObjectURL(await response.blob())
}
