// «Lo que pagas y lo que recuperas»: lo que se pierde sin agentes frente a lo que se paga,
// con los números que pone cada clínica. Es un ejemplo, nunca una promesa de resultados.
import { MIX, type ValuePrices } from "./pricing"
import { PRODUCT, WORDS, type WebProduct } from "./product"

export type ValueInput = {
  /** Personas que escriben al mes; cada una cuenta como conversación atendida. */
  writers: number
  /** De quienes escriben, % que hoy no recibe respuesta a tiempo. */
  unansweredPct: number
  /** De esos, % que se va a otra clínica. */
  leavePct: number
  /**
   * Pacientes que faltaron a su cita en el mes. Argos les ofrece otro horario
   * («Reprogramar tras una inasistencia») y la cita que reservan cuenta como
   * recuperada. Los controles vencidos no van aquí: Argos todavía no los
   * busca (darvin2c/odentIA#188).
   */
  noShows: number
  /** De quienes faltaron, % que vuelve a reservar si alguien le escribe. */
  returnPct: number
  /** Consultas que se dictarían al mes. */
  consultations: number
  /** Lo que cobra la clínica por una cita, en promedio. */
  appointmentValue: number
  /** Horas del equipo al mes en mensajes y notas, y lo que cuesta cada una. */
  teamHours: number
  hourCost: number
}

/**
 * Los números de ejemplo de la clínica mediana de cada producto.
 * - odentIA: la Clínica Sonrisa del estudio de precios (ADR 0085).
 * - latidIA: un consultorio de 4 médicos con unas 8 consultas al día cada uno en 22 días (~700); la
 *   consulta particular a USD 25 (unos S/ 90) y faltan 1 de cada 10. Son supuestos hasta medir los
 *   consultorios piloto; escribe más gente que en una clínica dental porque atiende a más pacientes.
 */
const MEDIAN_BY_PRODUCT: Record<WebProduct, ValueInput> = {
  dental: {
    writers: 300,
    unansweredPct: 40,
    leavePct: 20,
    noShows: 60,
    returnPct: 15,
    consultations: 300,
    appointmentValue: 40,
    teamHours: 60,
    hourCost: 4,
  },
  medical: {
    writers: 500,
    unansweredPct: 40,
    leavePct: 20,
    noShows: 70,
    returnPct: 15,
    consultations: 700,
    appointmentValue: 25,
    teamHours: 80,
    hourCost: 4,
  },
}

export const DEFAULT_VALUE_INPUT: ValueInput = MEDIAN_BY_PRODUCT[PRODUCT]

/** La cuenta con los precios vigentes: la cuota más lo que pasa del crédito. */
export function computeValue(i: ValueInput, prices: ValuePrices) {
  const lost = Math.round((((i.writers * i.unansweredPct) / 100) * i.leavePct) / 100)
  const recovered = Math.round((i.noShows * i.returnPct) / 100)
  const lostNew = lost * i.appointmentValue
  const lostNoShows = recovered * i.appointmentValue
  const lostTime = i.teamHours * i.hourCost
  const withoutUs = lostNew + lostNoShows + lostTime
  // Cada fila se cobra por su tipo (ADR 0085), con la mezcla de la clínica mediana: no hay un
  // «precio promedio» que alguien pague. Se reparten personas enteras, no fracciones.
  const t = prices.tiers
  const informa = Math.round(i.writers * MIX.informa)
  const gestiona = i.writers - informa
  const agenda = Math.round(gestiona * (MIX.agenda / MIX.gestiona))
  const simple = Math.round(i.consultations * MIX.simple)
  const estandar = Math.round(i.consultations * MIX.estandar)
  const completa = Math.max(0, i.consultations - simple - estandar)
  const byType = {
    informa: { count: informa, cost: informa * t.informa },
    gestiona: { count: gestiona, cost: gestiona * t.gestiona },
    /** La cita que se dio suma la diferencia hasta «Agenda». */
    agenda: { count: agenda, cost: agenda * (t.agenda - t.gestiona) },
    simple: { count: simple, cost: simple * t.simple },
    estandar: { count: estandar, cost: estandar * t.estandar },
    completa: { count: completa, cost: completa * t.completa },
  }
  const conversations = byType.informa.cost + byType.gestiona.cost + byType.agenda.cost
  const recoveredCost = recovered * prices.recovered
  const consultations = byType.simple.cost + byType.estandar.cost + byType.completa.cost
  const usage = conversations + recoveredCost + consultations
  const coveredByPlan = Math.min(prices.credit, usage)
  const withUs = prices.plan + Math.max(0, usage - prices.credit)
  return {
    lost,
    recovered,
    lostNew,
    lostNoShows,
    lostTime,
    withoutUs,
    byType,
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

export type ClinicSize = "pequena" | "mediana" | "grande"

/** Lo que cambia de la mediana en los tamaños pequeño y grande de cada producto. */
const SIZE_CHANGES: Record<WebProduct, Record<"pequena" | "grande", Partial<ValueInput>>> = {
  dental: {
    pequena: { writers: 120, noShows: 25, consultations: 120, teamHours: 25 },
    grande: { writers: 800, noShows: 160, consultations: 800, teamHours: 160 },
  },
  // 1 o 2 médicos (~250 consultas) y 10 o más (~1.800), con la misma cuenta que la mediana.
  medical: {
    pequena: { writers: 200, noShows: 25, consultations: 250, teamHours: 30 },
    grande: { writers: 1300, noShows: 180, consultations: 1800, teamHours: 200 },
  },
}

/** «Tu consultorio es Pequeño»: el tamaño concuerda con la palabra del producto. */
const SIZE_LABELS: Record<WebProduct, Record<ClinicSize, string>> = {
  dental: { pequena: "Pequeña", mediana: "Mediana", grande: "Grande" },
  medical: { pequena: "Pequeño", mediana: "Mediano", grande: "Grande" },
}

/** Tamaños de ejemplo para empezar sin escribir números; después se ajustan a mano. */
export const CLINIC_SIZES: { id: ClinicSize; label: string; hint: string; input: ValueInput }[] = [
  {
    id: "pequena",
    label: SIZE_LABELS[PRODUCT].pequena,
    hint: `1 o 2 ${WORDS.clinicians}`,
    input: { ...DEFAULT_VALUE_INPUT, ...SIZE_CHANGES[PRODUCT].pequena },
  },
  { id: "mediana", label: SIZE_LABELS[PRODUCT].mediana, hint: `3 a 6 ${WORDS.clinicians}`, input: DEFAULT_VALUE_INPUT },
  {
    id: "grande",
    label: SIZE_LABELS[PRODUCT].grande,
    hint: "7 o más, o varias sedes",
    input: { ...DEFAULT_VALUE_INPUT, ...SIZE_CHANGES[PRODUCT].grande },
  },
]

/** El tamaño cuyos números coinciden con los de la calculadora; si se tocaron, ninguno. */
export function sizeOf(i: ValueInput): ClinicSize | null {
  const keys = Object.keys(DEFAULT_VALUE_INPUT) as (keyof ValueInput)[]
  return CLINIC_SIZES.find((s) => keys.every((k) => s.input[k] === i[k]))?.id ?? null
}
