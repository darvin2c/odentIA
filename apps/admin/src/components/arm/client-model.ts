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
import { addDays, dayWords, limaDay, limaInstant, ORIGIN_WORDS } from "./sale-words"

// Las palabras del origen y las fechas de Lima son las de la venta (`sale-words.ts`): una sola copia.
export { dayWords, limaInstant, ORIGIN_WORDS }

/* ---------- Palabras ---------- */

export const STAGE_WORDS: Record<ClientStageName, string> = {
  contacto: "Contacto",
  presentacion_agendada: "Presentación agendada",
  presentacion_hecha: "Presentación hecha",
  propuesta: "Propuesta",
  entro: "Con cuenta",
  no_por_ahora: "No por ahora",
  perdido: "Perdido",
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
  con_cuenta: "Con cuenta",
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

export const HISTORY_CATEGORY_WORDS: Record<string, string> = {
  contactos: "Contactos",
  venta: "Venta",
  cuenta: "Cuenta y pagos",
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

export const clientListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  product,
  stage: z.string(),
  nextStep: nextStepSchema.nullable(),
  owner: person.nullable(),
  origin: z.string(),
  lastContactAt: z.string().nullable(),
  organizationId: z.string().nullable(),
  signals: z.array(signalSchema),
  createdAt: z.string(),
})
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
})
export type ActivityRow = z.infer<typeof activityRowSchema>

export const clientDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  product,
  stage: z.string(),
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
      sources: z.array(z.object({ text: z.string(), source: z.string() })),
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
export type ClientDetail = z.infer<typeof clientDetailSchema>

export const timelineEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  who: z.object({ kind: z.string(), name: z.string() }),
  category: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  adminOnly: z.boolean(),
  link: z.object({ kind: z.string(), id: z.string() }).optional(),
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
