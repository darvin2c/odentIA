/**
 * La Bandeja de la administración (`/api/admin/inbox`, ADR 0196): lo que nos escriben desde fuera de
 * la app, una conversación por persona y canal, con su estado. Solo Administración: Soporte trabaja
 * en su cola (el servidor le niega la Bandeja con 403).
 *
 * Una conversación es un chat (`kind: "chat"`, por su id) o el hilo de un correo (`kind: "correo"`,
 * por el último correo que llegó del hilo: el servidor arma el hilo entero a partir de cualquiera).
 */
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../../lib/api"

const enc = encodeURIComponent

export const INBOX_CHANNELS = ["correo", "whatsapp", "instagram", "messenger"] as const
export type InboxChannel = (typeof INBOX_CHANNELS)[number]

export const INBOX_CHANNEL_WORDS: Record<InboxChannel, string> = {
  correo: "Correo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Te toca (espera a una persona), Kairós respondió (ya salió) o Respondida. */
export const INBOX_STATES = ["te_toca", "kairos", "respondida"] as const
export type InboxState = (typeof INBOX_STATES)[number]

export const INBOX_STATE_WORDS: Record<InboxState, string> = {
  te_toca: "Te toca",
  kairos: "Kairós respondió",
  respondida: "Respondida",
}

/** La fase del cliente (la misma regla del servidor, `clientPhaseSql`). */
export const CLIENT_PHASES = ["por_vender", "en_alta", "activo", "no_por_ahora", "perdido"] as const
export type ClientPhase = (typeof CLIENT_PHASES)[number]

export const CLIENT_PHASE_WORDS: Record<ClientPhase, string> = {
  por_vender: "Por vender",
  en_alta: "En alta",
  activo: "Activo",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

/** Una palabra que no se conoce se lee como la primera: un valor nuevo no rompe la pantalla. */
const oneOf = <T extends readonly string[]>(values: T) =>
  z.string().transform((value) => ((values as readonly string[]).includes(value) ? value : values[0]) as T[number])

export const inboxItemSchema = z.object({
  kind: z.enum(["chat", "correo"]),
  /** El chat o el último correo que llegó del hilo: con él se abre. */
  id: z.string(),
  channel: oneOf(INBOX_CHANNELS),
  /** Quién escribió: su nombre, si lo dio, y su dirección (correo, número o cuenta). */
  who: z.object({ name: z.string().nullable(), address: z.string() }),
  subject: z.string().nullable(),
  /** Las primeras líneas de lo último que llegó; nulo si solo mandó un archivo o ya se borró. */
  preview: z.string().nullable(),
  attachments: z.number().int().nonnegative(),
  lastInboundAt: z.string(),
  lastActivityAt: z.string(),
  state: oneOf(INBOX_STATES),
  /** Por qué está así, en palabras: «Kairós dejó la respuesta lista», «No salió tu respuesta»… */
  stateWhy: z.string().nullable(),
  draftReady: z.boolean(),
  client: z
    .object({
      id: z.string(),
      name: z.string(),
      phase: oneOf(CLIENT_PHASES),
      product: z.string().nullable(),
      hasApp: z.boolean(),
    })
    .nullable(),
  /** Solo correo: el buzón y la dirección a la que llegó. */
  mailbox: z.string().nullable(),
  to: z.string().nullable(),
  attendedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  lastOutbound: z
    .object({ status: z.string(), byKairos: z.boolean(), at: z.string() })
    .nullable(),
})
export type InboxItem = z.infer<typeof inboxItemSchema>

export const inboxSchema = z.object({
  counts: z.object({
    teToca: z.number().int().nonnegative(),
    kairos: z.number().int().nonnegative(),
    sinCliente: z.number().int().nonnegative(),
  }),
  items: z.array(inboxItemSchema),
})
export type Inbox = z.infer<typeof inboxSchema>

export interface InboxFilter {
  estado?: InboxState | "todas"
  /** `sin` para lo que no tiene cliente, o el id de un cliente. */
  cliente?: string
  fase?: ClientPhase
  canal?: InboxChannel
  limit?: number
}

export const inboxKey = (filter: InboxFilter = {}) => ["admin", "inbox", filter] as const

export function inboxQueryString(filter: InboxFilter): string {
  const params = new URLSearchParams()
  if (filter.estado) params.set("estado", filter.estado)
  if (filter.cliente) params.set("cliente", filter.cliente)
  if (filter.fase) params.set("fase", filter.fase)
  if (filter.canal) params.set("canal", filter.canal)
  if (filter.limit) params.set("limit", String(filter.limit))
  const text = params.toString()
  return text ? `?${text}` : ""
}

export function useInbox(filter: InboxFilter = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: inboxKey(filter),
    queryFn: async () => inboxSchema.parse(await api<unknown>(`/api/admin/inbox${inboxQueryString(filter)}`)),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  })
}

/** El número del menú: solo lo que te toca. */
export function useInboxCount(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "inbox", "count"] as const,
    queryFn: async () =>
      z.object({ teToca: z.number().int().nonnegative() }).parse(await api<unknown>("/api/admin/inbox/count")),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  })
}

export const inboxItemPath = (item: Pick<InboxItem, "kind" | "id">) =>
  item.kind === "chat" ? `chat:${item.id}` : `correo:${item.id}`

export { enc as encodeInboxPart }
