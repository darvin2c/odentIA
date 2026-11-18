/**
 * Lo que la ficha y la lista de Clientes (el ARM de Sallca, ADR 0185) leen de
 * `/api/admin/clients`: los esquemas con que se valida cada respuesta, las
 * palabras de cada código y cómo se dicen sus fechas (en Lima, como el resto de
 * la administración). Los códigos que llegan se leen como texto: uno nuevo del
 * servidor no rompe la pantalla, solo se dice con su palabra de respaldo.
 */
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import type { QueryClient } from "@tanstack/react-query"
import { z } from "zod"
import type { ClientListView, ClientStageName } from "../../lib/list-search"
import { supportTime } from "../../lib/support-words"
import { CLIENT_PHASE_WORDS, CLIENT_PHASES, type ClientPhase } from "./inbox-api"
import { addDays, dayWords, limaDay, limaInstant, ORIGIN_WORDS } from "./sale-words"

// Las palabras del origen y las fechas de Lima son las de la venta (`sale-words.ts`): una sola copia.
export { dayWords, limaInstant, ORIGIN_WORDS }
// La fase es la de la Bandeja (`inbox-api.ts`): la misma regla del servidor, una sola copia.
export { CLIENT_PHASE_WORDS, CLIENT_PHASES, type ClientPhase }

/* ---------- Palabras ---------- */

/**
 * La etapa de la venta. «entro» (con cuenta) se dice por su fase, «En alta» o «Activo»
 * (`stageWords`); sin la fase a mano, «En alta». Nunca «Con cuenta» ni «Entró».
 */
export const STAGE_WORDS: Record<ClientStageName, string> = {
  contacto: "Contacto",
  presentacion_agendada: "Presentación agendada",
  presentacion_hecha: "Presentación hecha",
  propuesta: "Propuesta",
  entro: "En alta",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
}

/** La etapa de un cliente en palabras: con cuenta, su fase; si no, la etapa de su venta. */
export function stageWords(client: { stage: string; phase: string }): string {
  if (client.phase === "en_alta" || client.phase === "activo")
    return CLIENT_PHASE_WORDS[client.phase]
  return wordOf(STAGE_WORDS, client.stage, "Contacto")
}
/** Las etapas de la venta, antes de decidir: lo que está «por vender». */
export const SELLING_STAGES: readonly ClientStageName[] = [
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
]

export const VIEW_WORDS: Record<ClientListView, string> = {
  por_vender: "Por vender",
  en_alta: "En alta",
  activos: "Activos",
  no_por_ahora: "No por ahora",
  perdidos: "Perdidos",
  todos: "Todos",
}

export const PROFESSIONALS_WORDS: Record<string, string> = {
  "1": "1 profesional",
  "2-3": "de 2 a 3 profesionales",
  "4-9": "de 4 a 9 profesionales",
  "10+": "10 o más profesionales",
}
export const PROFESSIONALS_OPTIONS = ["1", "2-3", "4-9", "10+"] as const

export const TOOL_WORDS: Record<string, string> = {
  nada: "No usan nada",
  cuaderno_excel: "Cuaderno o Excel",
  otro_software: "Otro programa",
}
export const TOOL_OPTIONS = ["nada", "cuaderno_excel", "otro_software"] as const

export const ROLE_WORDS: Record<string, string> = { decide: "Decide", usa: "Usa", paga: "Paga" }
export const CONTACT_ROLES = ["decide", "usa", "paga"] as const

export const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: "WhatsApp",
  correo: "Correo",
  llamada: "Llamada",
}
export const CONTACT_CHANNELS = ["whatsapp", "correo", "llamada"] as const

export const TASK_KIND_WORDS: Record<string, string> = {
  llamar: "Llamar",
  escribir: "Escribir",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  alta: "Alta",
  cobro: "Cobro",
  otro: "Tarea",
}

export const ACTIVITY_WORDS: Record<string, string> = {
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  correo: "Correo",
  reunion: "Reunión",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  nota: "Nota",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** El estado del plan de una cuenta, como en Cobros. */
export const PLAN_STATUS_WORDS: Record<string, string> = {
  prueba: "En prueba",
  activa: "Activa",
  gracia: "En gracia",
  restringida: "Restringida",
  pausada: "Pausada",
  cancelada: "Cancelada",
}
export const planStatusVariant = (
  status: string | null,
): "success" | "warning" | "destructive" | "secondary" =>
  status === "activa"
    ? "success"
    : status === "gracia" || status === "pausada"
      ? "warning"
      : status === "restringida"
        ? "destructive"
        : "secondary"

/** La palabra de cada categoría del historial, en su fila. */
export const HISTORY_CATEGORY_WORDS: Record<string, string> = {
  conversaciones: "Conversación",
  venta: "Venta",
  alta: "Alta",
  plan: "Plan y pagos",
  soporte: "Soporte",
}

export const wordOf = (
  words: Record<string, string>,
  code: string | null | undefined,
  fallback = "—",
): string => (code && words[code]) || fallback

/* ---------- Fechas (en Lima) ---------- */

/** El día de Lima de un instante, `2026-11-12` (`limaDay`). */
export const limaDayOf = (date: Date): string => limaDay(date)

/** «hoy», «mañana», «ayer» o «jue 12 nov». */
export function relativeDayWords(day: string, now: Date = new Date()): string {
  const today = limaDayOf(now)
  if (day === today) return "hoy"
  if (day === addDays(today, 1)) return "mañana"
  if (day === addDays(today, -1)) return "ayer"
  return dayWords(day)
}

/** «hoy, 09:10», «ayer, 16:00» o «lun 9 nov, 10:54». */
export function whenWords(iso: string, now: Date = new Date()): string {
  return `${relativeDayWords(limaDayOf(new Date(iso)), now)}, ${supportTime(iso)}`
}

/** La hora de Lima de un instante, `HH:MM`. */
export const limaTimeOf = (iso: string): string => supportTime(iso)

/* ---------- Esquemas de las respuestas ---------- */

const product = z.enum(CLINICAL_PRODUCTS)
const person = z.object({ userId: z.string(), name: z.string() })
/** Una fase que no se conoce se lee «Por vender»: un valor nuevo no rompe la pantalla. */
const phase = z
  .string()
  .transform(
    (value): ClientPhase =>
      (CLIENT_PHASES as readonly string[]).includes(value) ? (value as ClientPhase) : "por_vender",
  )
  .optional()

/**
 * La fase si la respuesta no la trae (la API de antes, mientras se despliega): de la etapa y de si
 * tiene cuenta, con «En alta» para toda cuenta hasta que el servidor diga más.
 */
const phaseOf = (stage: string, hasAccount: boolean): ClientPhase =>
  hasAccount ? "en_alta" : stage === "no_por_ahora" || stage === "perdido" ? stage : "por_vender"

export const nextStepSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  title: z.string(),
  dueOn: z.string(),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
})
export type NextStep = z.infer<typeof nextStepSchema>

export const signalSchema = z.object({ code: z.string(), words: z.string() })
export type ClientSignal = z.infer<typeof signalSchema>

const clientListItemBase = z.object({
  id: z.string(),
  name: z.string(),
  product,
  stage: z.string(),
  phase,
  nextStep: nextStepSchema.nullable(),
  owner: person.nullable(),
  origin: z.string(),
  lastContactAt: z.string().nullable(),
  organizationId: z.string().nullable(),
  signals: z.array(signalSchema),
  createdAt: z.string(),
})
export const clientListItemSchema = clientListItemBase.transform((row) => ({
  ...row,
  phase: row.phase ?? phaseOf(row.stage, row.organizationId !== null),
}))
export type ClientListItem = z.infer<typeof clientListItemSchema>

export const clientListSchema = z.object({
  items: z.array(clientListItemSchema),
  total: z.number(),
  counts: z.record(z.string(), z.number()),
})

export const duplicateSchema = z.object({
  clientId: z.string().nullable(),
  requestId: z.string().nullable(),
  name: z.string(),
  why: z.string(),
  words: z.string(),
  hasAccount: z.boolean(),
})
export type DuplicateHint = z.infer<typeof duplicateSchema>
export const clientCreatedSchema = z.object({
  id: z.string(),
  duplicates: z.array(duplicateSchema),
})

export const contactRowSchema = z.object({
  id: z.string().nullable(),
  source: z.enum(["contacto", "miembro"]),
  name: z.string(),
  title: z.string().nullable(),
  roles: z.array(z.string()),
  rolesConfirmed: z.boolean(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  preferredChannel: z.string().nullable(),
  isPrimary: z.boolean(),
  user: z
    .object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.string().nullable(),
      roleLabel: z.string().nullable(),
    })
    .nullable(),
  readOnly: z.boolean(),
})
export type ContactRow = z.infer<typeof contactRowSchema>

export const taskRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  dueOn: z.string(),
  dueAt: z.string().nullable(),
  assignee: person.nullable(),
  contactId: z.string().nullable(),
  demoId: z.string().nullable(),
  byKairos: z.boolean(),
  overdue: z.boolean(),
})
export type TaskRow = z.infer<typeof taskRowSchema>

export const activityRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  direction: z.string().nullable(),
  body: z.string(),
  outcome: z.string().nullable(),
  happenedAt: z.string(),
  author: person.nullable(),
  byKairos: z.boolean(),
  contactId: z.string().nullable(),
  adminOnly: z.boolean(),
  /** Quien lo escribió, si llegó de fuera (un correo o un chat): nunca «Sistema». */
  from: z.string().nullable().default(null),
  /** El correo o la conversación que abre (solo Administración los recibe). */
  emailId: z.string().nullable().default(null),
  chatId: z.string().nullable().default(null),
})
export type ActivityRow = z.infer<typeof activityRowSchema>

const clientDetailBase = z.object({
  id: z.string(),
  name: z.string(),
  product,
  stage: z.string(),
  phase,
  /** En alta: los pasos hechos, de cuántos, y los nombres de los que faltan; si no, nulo. */
  alta: z
    .object({ done: z.number(), total: z.number(), missing: z.array(z.string()) })
    .nullable()
    .default(null),
  /** Activa: el primer pago que cuenta. */
  activeSince: z.string().nullable().default(null),
  openSupportCases: z.number().default(0),
  countryCode: z.string(),
  city: z.string().nullable(),
  professionals: z.string().nullable(),
  currentTool: z.string().nullable(),
  origin: z.string(),
  originDetail: z.string().nullable(),
  referredBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  owner: person.nullable(),
  organization: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      planStatus: z.string().nullable(),
    })
    .nullable(),
  nextStep: nextStepSchema.nullable(),
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
  summary: z
    .object({
      text: z.string(),
      // `label`: cómo se dice la fuente («Lo anotado», «Nos escribió por WhatsApp»), del servidor.
      sources: z.array(
        z.object({
          text: z.string(),
          source: z.string(),
          label: z.string().nullable().default(null),
        }),
      ),
      at: z.string().nullable(),
    })
    .nullable(),
  contacts: z.array(contactRowSchema),
  openTasks: z.array(taskRowSchema),
  recentActivities: z.array(activityRowSchema),
  signals: z.array(signalSchema),
  riskSignals: z.array(signalSchema),
  lastContactAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
})
export const clientDetailSchema = clientDetailBase.transform((row) => ({
  ...row,
  phase: row.phase ?? phaseOf(row.stage, row.organization !== null),
}))
export type ClientDetail = z.infer<typeof clientDetailSchema>

/**
 * Lo que abre una fila del historial: su cajón (correo, chat, envío, actividad, tarea, archivo,
 * propuesta, informe o carga), la cola de soporte o la pestaña que toca (`pestana`, con su nombre
 * en `id`). Un tipo que no se conoce se lee como texto y la fila abre su detalle.
 */
export const timelineLinkSchema = z.object({
  kind: z.string(),
  id: z.string(),
  orgId: z.string().optional(),
  number: z.number().optional(),
  loadId: z.string().optional(),
})
export type TimelineLink = z.infer<typeof timelineLinkSchema>

export const timelineEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  who: z.object({ kind: z.string(), name: z.string() }),
  category: z.string(),
  /** El canal o lo que es, para su ícono. */
  icon: z.string().default("nota"),
  title: z.string(),
  detail: z.string().optional(),
  adminOnly: z.boolean(),
  link: timelineLinkSchema.optional(),
  /** Una actividad: el texto entero y en qué quedó. */
  body: z.string().optional(),
  outcome: z.string().optional(),
  /** Un envío sin conversación: por dónde, a quién, qué decía y cómo quedó. */
  envio: z
    .object({
      channel: z.string(),
      to: z.string(),
      subject: z.string().nullable(),
      body: z.string(),
      status: z.string(),
    })
    .optional(),
})
export type TimelineEntry = z.infer<typeof timelineEntrySchema>
export const timelineSchema = z.object({
  items: z.array(timelineEntrySchema),
  nextBefore: z.string().nullable(),
})

/** El equipo de la administración (Equipo), para elegir responsable. */
export const staffSchema = z.object({
  staff: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.string(),
      active: z.boolean(),
    }),
  ),
})

/* ---------- Caché ---------- */

export const clientKey = (clientId: string) => ["admin", "client", clientId] as const

/** Después de cambiar algo de un cliente: su ficha, las listas, Kairós e Inicio. */
export function invalidateClient(queryClient: QueryClient, clientId: string): void {
  void queryClient.invalidateQueries({ queryKey: clientKey(clientId) })
  void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] })
  void queryClient.invalidateQueries({ queryKey: ["admin", "kairos"] })
  void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
}

/** El país en palabras («Perú»), o su código si el navegador no lo sabe decir. */
export function countryWords(code: string): string {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

/** El próximo paso en palabras: «Hoy, 16:00 · Presentación con Luis» o «Venció el lun 9 nov · Llamar». */
export function nextStepWords(
  step: NextStep,
  now: Date = new Date(),
): { when: string; what: string } {
  const day = relativeDayWords(step.dueOn, now)
  const at = step.dueAt ? `, ${limaTimeOf(step.dueAt)}` : ""
  const when =
    step.overdue && step.dueOn < limaDayOf(now)
      ? `Venció el ${dayWords(step.dueOn)}`
      : `${day.charAt(0).toUpperCase()}${day.slice(1)}${at}`
  return { when, what: step.title || wordOf(TASK_KIND_WORDS, step.kind, "Tarea") }
}
