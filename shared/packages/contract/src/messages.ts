import { z } from "zod"

/**
 * El acuerdo entre una app que es otro sistema (gestorIA) y la administración (ADR 0211, paso 4
 * del lienzo A): lo único que se dicen. Nadie lee la base del otro.
 *
 * - **La app avisa** (`POST` a `CONTRACT_PATHS.events`): abrió o cambió una cuenta, esto usó,
 *   pide soporte y quién está en su equipo. Cada aviso va firmado (`signing.ts`) y su `webhook-id` es su clave: repetido con
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

/**
 * Lo que la administración le pide a la app (`POST` a la dirección de la app más
 * `APP_CONTRACT_PATHS.requests`), firmado con el mismo secreto del par: abrir la cuenta de un
 * cliente, dejar entrar a soporte y quitar a una persona.
 */
export const APP_CONTRACT_PATHS = { requests: "/acuerdo/pedidos" } as const

/** Lo más que pesa un mensaje en cualquiera de los dos sentidos (salvo un aviso con su comprobante). */
export const CONTRACT_MAX_BODY_BYTES = 64 * 1024

/**
 * El comprobante de pago que sube la app viaja dentro de su aviso (`pago.comprobante`), en
 * base64: así nadie lee el almacenamiento del otro ni hace falta un enlace. Tipos y tope: los de
 * una foto o un PDF de una pantalla; la administración vuelve a mirar el contenido.
 */
export const CONTRACT_RECEIPT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const
export const CONTRACT_MAX_RECEIPT_BYTES = 1_500_000
/** Lo que ocupa ese archivo en base64. */
export const CONTRACT_MAX_RECEIPT_BASE64 = Math.ceil((CONTRACT_MAX_RECEIPT_BYTES * 4) / 3) + 4
/** Lo más que pesa un aviso a `CONTRACT_PATHS.events`: el comprobante en base64 y sus datos. */
export const CONTRACT_MAX_EVENT_BYTES = CONTRACT_MAX_RECEIPT_BASE64 + 16 * 1024

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

/**
 * Pide soporte: abre un caso de la cuenta, a nombre de quien pregunta. Puede preguntar cualquier
 * rol de la cuenta (ADR 0221): por eso dice, si la app lo sabe, desde qué pantalla y con qué rol,
 * como el caso que abre una clínica desde su Ayuda. Los dos son opcionales: una app que todavía
 * no los manda sigue entrando igual.
 */
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
    /** La pantalla de la app desde la que preguntó (su ruta dentro de la cuenta). */
    screen: z.string().trim().min(1).max(200).nullable().optional(),
    /** El rol de quien preguntó en la cuenta, con el nombre que le da la app. */
    role: z.string().trim().min(1).max(80).nullable().optional(),
  }),
})

/**
 * Subió un comprobante de pago de un cargo: queda por confirmar en la administración, como el que
 * sube una clínica. El cargo y el medio de pago son los que la app leyó en el estado de la cuenta.
 * La clave del aviso es la del pago: repetido, no se registra dos veces.
 */
export const receiptEvent = z.object({
  type: z.literal("pago.comprobante"),
  timestamp: instant,
  data: z.object({
    account: accountRef,
    userId,
    chargeId: z.string().trim().min(1).max(200),
    amountCents: z.number().int().positive(),
    methodCode: z.string().trim().min(1).max(80),
    file: z.object({
      contentType: z.enum(CONTRACT_RECEIPT_TYPES),
      /** En base64 estándar; el tope es el del archivo. */
      base64: z
        .string()
        .min(4)
        .max(CONTRACT_MAX_RECEIPT_BASE64)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, "El archivo va en base64"),
    }),
    note: z.string().trim().max(500).nullable().optional(),
  }),
})

/**
 * Los roles de una persona en una cuenta de la app, para la cuenta única: dueño (decide el plan y
 * nunca falta), administrador y quien atiende (en gestorIA, Dueño, Administrador y Ventas). Una
 * app con otros nombres dice cuál de estos es cada uno.
 */
export const TEAM_ROLES = ["owner", "admin", "sales"] as const
export type TeamRole = (typeof TEAM_ROLES)[number]
/** Lo más que se acepta en el equipo de una cuenta en un solo aviso. */
export const MAX_TEAM_MEMBERS = 500

/**
 * Quién está en una cuenta de la app y con qué rol, entero: lo que la cuenta única guarda para
 * mostrar a cada persona sus lugares (el selector de las clínicas) y para no cerrar la cuenta del
 * único dueño. Se avisa al abrirla y en cada alta, baja o cambio de rol, y la app lo repite si no
 * sabe si la cuenta lo tiene. Siempre el equipo entero, nunca el cambio: repetido o en desorden
 * da lo mismo, y manda el de `timestamp` más nuevo. Un equipo vacío es que ya nadie está.
 */
export const teamChangedEvent = z.object({
  type: z.literal("equipo.cambiado"),
  timestamp: instant,
  data: z.object({
    account: accountRef,
    /** El nombre de la cuenta (en gestorIA, la tienda), como lo verá la persona. */
    name: z.string().trim().min(1).max(200),
    members: z
      .array(z.object({ userId, role: z.enum(TEAM_ROLES) }))
      .max(MAX_TEAM_MEMBERS)
      .refine(
        (members) => new Set(members.map((one) => one.userId)).size === members.length,
        "Cada persona va una sola vez",
      ),
  }),
})

export const appEvent = z.discriminatedUnion("type", [
  accountOpenedEvent,
  usageEvent,
  supportEvent,
  receiptEvent,
  teamChangedEvent,
])
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
  /** Cómo se le puede pagar a la administración (sus medios activos), para el comprobante. */
  paymentMethods: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        instructions: z.string().nullable(),
      }),
    )
    .default([]),
  /**
   * Los casos de soporte de la cuenta con las respuestas del equipo. `userId` es quien lo abrió:
   * la app le muestra a cada persona solo lo suyo (ADR 0221). Sin él (una administración que aún
   * no lo manda), el caso es solo de quien ve el plan.
   */
  support: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      question: z.string(),
      createdAt: instant,
      userId: z.string().nullable().optional(),
      replies: z.array(z.object({ body: z.string(), at: instant })),
    }),
  ),
})
export type AccountState = z.infer<typeof accountState>

/* ---------- Lo que la administración le pide a la app ---------- */

/** Una persona de la cuenta única por su id (el `sub` de su token). */
const person = z.object({
  userId,
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
})
const reason = z.string().trim().min(3).max(500)

/**
 * Abrir la cuenta de un cliente con su plan: la administración ya la abrió de su lado (con el id
 * que manda) y la app crea la cuenta con ese id, a nombre de su dueño. Repetido, no abre otra.
 */
export const openAccountRequest = z.object({
  type: z.literal("cuenta.abrir"),
  timestamp: instant,
  data: z.object({
    account: z.uuid(),
    name: z.string().trim().min(1).max(80),
    /** ISO 4217: la moneda en que vende. */
    currency,
    country: country.nullable(),
    owner: person,
  }),
})

/** Lo más que dura la entrada de soporte, como en las clínicas. */
export const SUPPORT_ACCESS_MAX_MINUTES = 60

/**
 * Dejar entrar a soporte: una persona del equipo pide mirar la cuenta un rato, para algo. La app
 * decide cómo (en gestorIA lo acepta su Dueño o su Administrador) y lo deja anotado.
 */
export const supportAccessRequest = z.object({
  type: z.literal("soporte.entrar"),
  timestamp: instant,
  data: z.object({
    account: accountRef,
    staff: person,
    minutes: z.number().int().min(5).max(SUPPORT_ACCESS_MAX_MINUTES),
    reason,
  }),
})

/** Quitar a una persona de la cuenta, con el motivo. */
export const removePersonRequest = z.object({
  type: z.literal("equipo.quitar"),
  timestamp: instant,
  data: z.object({ account: accountRef, userId, reason }),
})

export const adminRequest = z.discriminatedUnion("type", [
  openAccountRequest,
  supportAccessRequest,
  removePersonRequest,
])
export type AdminRequest = z.infer<typeof adminRequest>
export type AdminRequestType = AdminRequest["type"]

/**
 * Lo que responde la app a un pedido (siempre 200 si lo leyó): «hecho» o «fallo» con su motivo
 * en palabras para el equipo (es la app la que sabe por qué). Repetido con la misma clave, la
 * misma respuesta. Cualquier otra respuesta (sin firma, caída) se reintenta con la misma clave.
 */
export const adminRequestResult = z.object({
  status: z.enum(["hecho", "fallo"]),
  message: z.string().max(500).nullable(),
})
export type AdminRequestResult = z.infer<typeof adminRequestResult>
