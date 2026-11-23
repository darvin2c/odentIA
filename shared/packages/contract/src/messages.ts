import { z } from "zod"

/**
 * El acuerdo entre una app que es otro sistema (gestorIA) y la administración (ADR 0211, paso 4
 * del lienzo A): lo único que se dicen. Nadie lee la base del otro.
 *
 * - **La app avisa** (`POST` a `CONTRACT_PATHS.events`): abrió o cambió una cuenta, esto usó y
 *   pide soporte. Cada aviso va firmado (`signing.ts`) y su `webhook-id` es su clave: repetido con
 *   la misma clave, la administración lo reconoce y no lo cuenta dos veces. La app reintenta lo
 *   que no sabe si llegó, siempre con la misma clave.
 * - **La app pregunta** (`POST` a `CONTRACT_PATHS.state`, también firmado): si la cuenta puede
 *   seguir y su tope, su plan, sus cargos y pagos (para «Plan y pagos»), los avisos que debe
 *   mostrar y las respuestas de soporte.
 * - **La app nunca se detiene por la administración**: si no responde, sigue con lo último que
 *   supo (`AccountState.at` dice de cuándo es). La app cuenta y la administración cobra: los
 *   precios son del plan de cada cuenta y la app nunca los calcula.
 *
 * Los textos que ve la gente los escribe la app: aquí van datos (estados, familias, importes en
 * la unidad menor de su moneda ISO 4217), no frases.
 */

export const CONTRACT_PATHS = {
  events: "/api/contract/events",
  state: "/api/contract/state",
} as const

/** Lo más que pesa un mensaje en cualquiera de los dos sentidos. */
export const CONTRACT_MAX_BODY_BYTES = 64 * 1024

/** La referencia de la cuenta en la app (en gestorIA, su tienda): la app la elige y no cambia. */
const accountRef = z.string().trim().min(1).max(200)
const userId = z.string().trim().min(1).max(200)
/** Fecha y hora ISO 8601 con zona. */
const instant = z.iso.datetime({ offset: true })
/** País ISO 3166-1 alfa-2, en mayúsculas. */
const country = z.string().regex(/^[A-Z]{2}$/, "El país va en ISO 3166-1 alfa-2, p. ej. PE")

/**
 * Abrió o cambió una cuenta: quién es, de qué país y quién es su dueño. La primera vez la abre;
 * después la pone al día. Llegan en desorden si se reintentan: manda el de `timestamp` más nuevo.
 */
export const accountOpenedEvent = z.object({
  type: z.literal("cuenta.abierta"),
  timestamp: instant,
  data: z.object({
    account: accountRef,
    name: z.string().trim().min(1).max(200),
    country: country.nullable(),
    /** La persona dueña, por su id en la cuenta única (el `sub` de su token). */
    ownerUserId: userId,
  }),
})

/**
 * Lo que hizo el agente de la app y se cobra: una conversación atendida, que sube si tomó un
 * pedido. Una por conversación (`conversation`): si primero llega «atendida» y después «pedido»,
 * sube mientras no se haya cobrado; repetida, no se cuenta otra vez.
 */
export const USAGE_OUTCOMES = ["atendida", "pedido"] as const
export const USAGE_CHANNELS = ["whatsapp", "instagram", "messenger", "webchat"] as const
export const usageEvent = z.object({
  type: z.literal("uso.contado"),
  timestamp: instant,
  data: z.object({
    account: accountRef,
    kind: z.literal("conversacion"),
    outcome: z.enum(USAGE_OUTCOMES),
    /** La conversación en la app: la misma clave en sus dos avisos. */
    conversation: z.string().trim().min(1).max(200),
    occurredAt: instant,
    channel: z.enum(USAGE_CHANNELS).nullable().optional(),
  }),
})

/** Pide soporte: abre un caso de la cuenta, a nombre de quien pregunta. */
export const SUPPORT_KINDS = ["pregunta", "problema", "cobro"] as const
export const supportEvent = z.object({
  type: z.literal("soporte.pedido"),
  timestamp: instant,
  data: z.object({
    account: accountRef,
    userId,
    kind: z.enum(SUPPORT_KINDS),
    question: z.string().trim().min(1).max(500),
    detail: z.string().trim().max(4000).nullable().optional(),
  }),
})

export const appEvent = z.discriminatedUnion("type", [accountOpenedEvent, usageEvent, supportEvent])
export type AppEvent = z.infer<typeof appEvent>
export type AppEventType = AppEvent["type"]

/** Lo que responde la administración a un aviso: recibido, y si ya lo tenía por su clave. */
export const appEventReceipt = z.object({ received: z.literal(true), repeated: z.boolean() })
export type AppEventReceipt = z.infer<typeof appEventReceipt>

/** Lo que pregunta la app: el estado de una cuenta. */
export const stateQuestion = z.object({ account: accountRef })
export type StateQuestion = z.infer<typeof stateQuestion>

const money = z.number().int()
const currency = z.string().regex(/^[A-Z]{3}$/)

/** Lo que responde la administración del estado de una cuenta. */
export const accountState = z.object({
  account: accountRef,
  /** No la conoce: la app avisa primero que se abrió (`cuenta.abierta`). */
  found: z.boolean(),
  /** Cuándo se respondió: la app guarda lo último que supo y sigue con eso si no hay respuesta. */
  at: instant,
  access: z
    .object({
      /** ¿Puede seguir usando la app? En falso, la cuenta solo lee: puede pagar y pedir ayuda. */
      allowed: z.boolean(),
      status: z.enum([
        "prueba",
        "activa",
        "gracia",
        "restringida",
        "pausada",
        "cancelada",
        "sin_suscripcion",
      ]),
      reason: z.string().nullable(),
      /** En gracia: desde cuándo queda en solo lectura si no paga. */
      readOnlyAt: instant.nullable(),
      trialEndsAt: instant.nullable(),
    })
    .nullable(),
  /** Lo que detiene al agente por dinero: se acabó el saldo de prueba o llegó a su tope. */
  agents: z.object({ trialExhausted: z.boolean(), capReached: z.boolean() }).nullable(),
  /** El gasto del tramo frente a su crédito y su tope. */
  budget: z
    .object({
      currency: currency.nullable(),
      creditCents: money,
      creditUsedCents: money,
      capCents: money.nullable(),
      spentCents: money,
      periodStart: instant,
      periodEnd: instant,
    })
    .nullable(),
  plan: z
    .object({ code: z.string(), name: z.string(), currency, priceCents: money, creditCents: money })
    .nullable(),
  charges: z.array(
    z.object({
      id: z.string(),
      periodStart: instant,
      periodEnd: instant,
      amountCents: money,
      paidCents: money,
      currency,
      status: z.string(),
      dueAt: instant.nullable(),
      lines: z.array(
        z.object({
          kind: z.string(),
          description: z.string(),
          quantity: z.number().int(),
          amountCents: money,
        }),
      ),
    }),
  ),
  payments: z.array(
    z.object({
      id: z.string(),
      chargeId: z.string().nullable(),
      amountCents: money,
      currency,
      status: z.string(),
      at: instant,
    }),
  ),
  /** Los avisos que la app debe mostrar: cada uno una vez por `key`, con sus palabras. */
  notices: z.array(
    z.object({ key: z.string(), family: z.string(), level: z.string(), action: z.string() }),
  ),
  /** Los casos de soporte de la cuenta con las respuestas del equipo. */
  support: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      question: z.string(),
      createdAt: instant,
      replies: z.array(z.object({ body: z.string(), at: instant })),
    }),
  ),
})
export type AccountState = z.infer<typeof accountState>
