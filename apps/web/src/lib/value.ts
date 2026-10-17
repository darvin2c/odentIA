// «Lo que pagas y lo que recuperas»: lo que se pierde sin agentes frente a lo que se paga,
// con los números que pone cada clínica. Es un ejemplo, nunca una promesa de resultados.
import { CONSULTATION, CONVERSATION, PLAN, RECOVERED } from "./pricing"

export type ValueInput = {
  /** Personas que escriben al mes; cada una cuenta como conversación atendida. */
  writers: number
  /** De quienes escriben, % que hoy no recibe respuesta a tiempo. */
  unansweredPct: number
  /** De esos, % que se va a otra clínica. */
  leavePct: number
  /** Pacientes con su control vencido. */
  overdue: number
  /** De los controles vencidos, % que vuelve si alguien le escribe. */
  returnPct: number
  /** Consultas que se dictarían al mes. */
  consultations: number
  /** Lo que cobra la clínica por una cita, en promedio. */
  appointmentValue: number
  /** Horas del equipo al mes en mensajes y notas, y lo que cuesta cada una. */
  teamHours: number
  hourCost: number
}

export const DEFAULT_VALUE_INPUT: ValueInput = {
  writers: 300,
  unansweredPct: 40,
  leavePct: 20,
  overdue: 60,
  returnPct: 15,
  consultations: 300,
  appointmentValue: 40,
  teamHours: 60,
  hourCost: 4,
}

export function computeValue(i: ValueInput) {
  const lost = Math.round((((i.writers * i.unansweredPct) / 100) * i.leavePct) / 100)
  const recovered = Math.round((i.overdue * i.returnPct) / 100)
  const lostNew = lost * i.appointmentValue
  const lostControls = recovered * i.appointmentValue
  const lostTime = i.teamHours * i.hourCost
  const withoutUs = lostNew + lostControls + lostTime
  const conversations = i.writers * CONVERSATION
  const recoveredCost = recovered * RECOVERED
  const consultations = i.consultations * CONSULTATION
  const usage = conversations + recoveredCost + consultations
  const coveredByPlan = Math.min(PLAN, usage)
  const withUs = Math.max(PLAN, usage)
  return {
    lost,
    recovered,
    lostNew,
    lostControls,
    lostTime,
    withoutUs,
    conversations,
    recoveredCost,
    consultations,
    usage,
    coveredByPlan,
    withUs,
    inFavor: withoutUs - withUs,
    ratio: withUs > 0 ? withoutUs / withUs : 0,
    worthIt: withoutUs > withUs,
  }
}
