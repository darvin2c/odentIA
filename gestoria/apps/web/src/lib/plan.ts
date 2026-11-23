import type { AccountState, SUPPORT_KINDS } from "@odentia/contract"

/**
 * Lo que la pantalla sabe de «Plan y pagos» (paso B7): lo que la administración dijo de la tienda
 * (datos del acuerdo, `@odentia/contract`) y sus palabras para la persona. Los textos los escribe
 * gestorIA: la administración manda estados, no frases.
 */

export type AgentStop = "sin_acceso" | "saldo_prueba" | "tope"

export interface PlanView {
  /** gestorIA está conectada a la administración (hay secreto). */
  connected: boolean
  /** Lo último que dijo la administración; null si nunca respondió. */
  state: AccountState | null
  receivedAt: string | null
  /** La última pregunta no tuvo respuesta: lo que se ve es lo último que se supo. */
  stale: boolean
  agentStop: AgentStop | null
  pendingSupport: { question: string; createdAt: string }[]
}

type Status = NonNullable<AccountState["access"]>["status"]

export const STATUS_WORDS: Record<Status, string> = {
  prueba: "En prueba",
  activa: "Activa",
  gracia: "Pago pendiente",
  restringida: "Restringida",
  pausada: "En pausa",
  cancelada: "Cancelada",
  sin_suscripcion: "Sin plan",
}

/** Por qué Sofi no atiende tus conversaciones. */
export const AGENT_STOP_WORDS: Record<AgentStop, string> = {
  sin_acceso:
    "Sofi no está atendiendo: tu plan está detenido hasta ponerte al día. Tus conversaciones esperan a una persona del equipo.",
  saldo_prueba:
    "Sofi no está atendiendo: se acabó el saldo de tu prueba. Tus conversaciones esperan a una persona del equipo.",
  tope: "Sofi no está atendiendo: llegó al tope de gasto de este mes. Tus conversaciones esperan a una persona del equipo.",
}

type Level = "aviso" | "alarma" | "limite"

/** Cada aviso de la administración, por su familia y su nivel. */
const NOTICE_WORDS: Record<string, Partial<Record<Level, string>>> = {
  saldo_prueba: {
    aviso: "Ya usaste buena parte del saldo de tu prueba.",
    alarma: "Te queda poco saldo de prueba.",
    limite: "Se acabó el saldo de tu prueba: Sofi está en pausa hasta que tengas un plan.",
  },
  dias_prueba: {
    aviso: "Tu prueba termina en unos días.",
    alarma: "Tu prueba termina muy pronto.",
  },
  credito: {
    aviso: "Ya usaste buena parte del crédito que incluye tu plan.",
    alarma: "Te queda poco del crédito que incluye tu plan.",
    limite: "Usaste el crédito que incluye tu plan: lo que sigue se suma a tu próximo cobro.",
  },
  tope: {
    aviso: "Te acercas al tope de gasto de este mes.",
    alarma: "Estás muy cerca del tope de gasto de este mes.",
    limite: "Llegaste al tope de gasto de este mes: Sofi está en pausa.",
  },
  precio_especial: { aviso: "Tu precio especial termina pronto." },
  condiciones: { aviso: "Cambiaron las condiciones del servicio." },
}

/** Lo que se hace con el aviso: aquí, pedirlo a soporte. */
const NOTICE_ACTIONS: Record<string, string> = {
  elegir_plan: "Para elegir tu plan, escríbenos en «Pedir ayuda».",
  cambiar_tope: "Para subir el tope, escríbenos en «Pedir ayuda».",
}

export function noticeText(notice: AccountState["notices"][number]): string {
  const level = noticeTone(notice.level)
  const words = NOTICE_WORDS[notice.family]?.[level] ?? "Tienes un aviso sobre tu plan."
  const action = NOTICE_ACTIONS[notice.action]
  return action ? `${words} ${action}` : words
}

export function noticeTone(level: string): Level {
  return level === "limite" ? "limite" : level === "alarma" ? "alarma" : "aviso"
}

export const NOTICE_LABELS: Record<Level, string> = {
  aviso: "Aviso",
  alarma: "Alarma",
  limite: "En pausa",
}

export const CHARGE_WORDS: Record<string, string> = {
  pendiente: "Por pagar",
  parcial: "Pagado en parte",
  pagada: "Pagado",
  reversada: "Revertido",
  anulada: "Anulado",
}

export const PAYMENT_WORDS: Record<string, string> = {
  pendiente: "Por confirmar",
  confirmado: "Confirmado",
  reversado: "Revertido",
  devuelto: "Devuelto",
  rechazado: "Rechazado",
}

export const SUPPORT_STATUS_WORDS: Record<string, string> = {
  abierto: "Recibida",
  en_atencion: "En atención",
  esperando_clinica: "Te respondimos",
  resuelto: "Resuelta",
}

export type SupportKind = (typeof SUPPORT_KINDS)[number]

/** Los tipos de pregunta del acuerdo, con su nombre. */
export const SUPPORT_KIND_LABELS: Record<SupportKind, string> = {
  pregunta: "Una pregunta",
  problema: "Algo no funciona",
  cobro: "Sobre un cobro",
}
