import type { Balance, OrderChannel, OrderState } from "./pedidos"
import type { AgentStop } from "./plan"
import type { PaymentCollection } from "./tienda"

/** Lo que la pantalla sabe de Sofi, Argos y Reportes (paso B5), como lo dice el servidor. */

export interface AgentSettings {
  enabled: boolean
  displayName: string | null
  knowledge: string
  followPayment: boolean
  followThanks: boolean
  followRestock: boolean
  followReturn: boolean
}

export interface SofiOverview {
  settings: AgentSettings
  /** Hay modelo configurado: Sofi puede responder. */
  modelReady: boolean
  tests: { id: string; createdAt: string; updatedAt: string; customerName: string | null }[]
  /** La administración detuvo a Sofi en las conversaciones de verdad (la de prueba sigue). */
  agentStop: AgentStop | null
}

export interface ConversationMessage {
  id: string
  author: "cliente" | "sofi" | "persona"
  text: string
  createdAt: string
  delivery: "prueba" | "sin_enviar" | null
  needsTemplate: boolean
  followUp: "pago" | "gracias" | "volvio" | "volver" | null
  byArgos: boolean
  basis?: { tools: string[]; stopped: string[]; handoff: string | null; costMicros: number | null }
}

export interface ConversationView {
  id: string
  channel: "whatsapp" | "instagram" | "messenger" | "prueba"
  customerName: string | null
  handler: "sofi" | "persona"
  waitingReason: string | null
  costMicros: number
  messages: ConversationMessage[]
  orders: {
    id: string
    number: string
    state: OrderState
    paymentCollection: PaymentCollection
    totalCents: number
    test: boolean
    balance: Balance
  }[]
}

export type AnswerStatus =
  | "respondio"
  | "persona"
  | "apagada"
  | "nada"
  | "ocupada"
  | "sin_modelo"
  | "detenida"

export interface StoreReport {
  period: "hoy" | "semana" | "mes"
  /** Lo cobrado menos lo que la tienda devolvió (`refundedCents`, ya restado). */
  sold: { cents: number; orders: number; ticketCents: number; refundedCents: number }
  /** Lo que espera a una persona y lo que falta cobrar (total − confirmado − por confirmar). */
  pending: Record<"toConfirm" | "due", { orders: number; cents: number }>
  conversations: { total: number; bought: number }
  returning: number
  channels: { channel: OrderChannel; orders: number; cents: number }[]
  products: {
    productId: string
    name: string
    sold: number
    stock: number
    daysLeft: number | null
  }[]
  agent: {
    conversations: number
    passedToPerson: number
    orders: number
    cents: number
    /** Lo que volvió de sus pedidos, a lo que se pagó: el cobro lo descuenta. */
    returnedCents: number
    marginCents: number
    marginUsedCents: number
    costMicros: number
    costPerConversationMicros: number
  }
}

export interface ArgosBoard {
  toDo: {
    kind: "pago" | "stock_pedido" | "reponer" | "conversacion"
    title: string
    detail: string
    orderId?: string
    conversationId?: string
    at?: string
  }[]
  done: {
    kind: "pago" | "gracias" | "volvio" | "volver"
    title: string
    messages: { customer: string | null; text: string; needsTemplate: boolean; at: string }[]
  }[]
  week: {
    collectedCents: number
    previousCents: number
    changePercent: number | null
    conversations: number
    passedToPerson: number
  }
}

/** Lo que costó, en dólares («US$ 0.004»): el modelo se paga en dólares. */
export function usd(micros: number): string {
  const value = micros / 1_000_000
  return `US$ ${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`
}
