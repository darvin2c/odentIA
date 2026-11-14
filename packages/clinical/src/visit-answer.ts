import { z } from "zod"
import type { RegistrationConfig, RegistrationFieldKey } from "./patient-registration.js"

/**
 * «Tu visita», antes de cada cita (mesa de formularios del 13 nov, entrega 8): a qué viene, con sus
 * palabras; si le duele ahora y cuánto (0 a 10), y algo más. Lo que se pregunta lo marca la clínica
 * en «Preguntas al paciente» (grupo «Antes de cada cita»). Todo es opcional: no responder no frena
 * nada, ni el envío de sus datos ni la atención.
 *
 * En una sesión o un control ya se sabe a qué viene: se le dice («Vienes a: sesión 2 de
 * endodoncia») y solo se le pregunta si le duele.
 *
 * Una sola regla para su enlace, su portal, «Hoy viene a…», la Historia y la copia de su historia.
 */

export const VISIT_FIELDS = ["visit.reason", "visit.pain", "visit.more"] as const satisfies readonly RegistrationFieldKey[]

/** Qué se le pregunta de su visita. */
export interface VisitQuestions {
  reason: boolean
  pain: boolean
  more: boolean
}

/**
 * Lo que se le pregunta antes de esta cita: lo que la clínica no marcó «No preguntar». Con
 * `purpose` (una sesión o un control) no se le pregunta a qué viene: se le dice.
 */
export function visitQuestionsOf(config: Pick<RegistrationConfig, "fields">, purpose: string | null): VisitQuestions {
  const asked = (key: (typeof VISIT_FIELDS)[number]) => config.fields[key] !== undefined && config.fields[key] !== "hidden"
  return {
    reason: !purpose && asked("visit.reason"),
    pain: asked("visit.pain"),
    more: !purpose && asked("visit.more"),
  }
}

export function asksAnything(questions: VisitQuestions): boolean {
  return questions.reason || questions.pain || questions.more
}

const words = (max: number) => z.string().trim().max(max, `Máximo ${max} caracteres`)

/** Lo que envía: todo opcional; cuánto le duele, solo si dijo que le duele. */
export const visitAnswerSchema = z
  .strictObject({
    reason: words(2000).optional(),
    pain: z.enum(["si", "no"]).optional(),
    painLevel: z.number().int().min(0, "De 0 a 10").max(10, "De 0 a 10").optional(),
    more: words(2000).optional(),
  })
  .refine((value) => value.painLevel === undefined || value.pain === "si", {
    message: "Cuánto le duele se dice solo si le duele",
    path: ["painLevel"],
  })
export type VisitAnswerInput = z.infer<typeof visitAnswerSchema>

/** Lo que dijo, como se guarda y se lee. */
export interface VisitAnswer {
  reason: string | null
  pain: "si" | "no" | null
  painLevel: number | null
  more: string | null
  /** Lo que se le dijo que venía a hacer, si era una sesión o un control. */
  toldPurpose: string | null
}

/** Si contó algo: una respuesta en blanco no es nada que mostrar. */
export function visitAnswerHasContent(answer: Pick<VisitAnswer, "reason" | "pain" | "more">): boolean {
  return !!answer.reason?.trim() || answer.pain !== null || !!answer.more?.trim()
}

/** «Dolor ahora: 8 de 10», «Sin dolor», «Le duele» (sin cuánto); nulo si no respondió. */
export function visitPainWords(answer: Pick<VisitAnswer, "pain" | "painLevel">): string | null {
  if (answer.pain === "no") return "Sin dolor"
  if (answer.pain !== "si") return null
  return answer.painLevel !== null ? `Dolor ahora: ${answer.painLevel} de 10` : "Le duele"
}

/**
 * Lo que contó en una línea, igual en la atención firmada, la Historia y la copia: «Me duele la
 * muela…» · dolor 8 de 10 · «Que me avisen antes de la inyección».
 */
export function visitAnswerLine(answer: VisitAnswer): string {
  const pain = visitPainWords(answer)
  return [
    answer.reason?.trim() ? `«${answer.reason.trim()}»` : answer.toldPurpose ? `Vino a: ${answer.toldPurpose}` : null,
    pain ? pain.charAt(0).toLowerCase() + pain.slice(1) : null,
    answer.more?.trim() ? `además: «${answer.more.trim()}»` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * «Usar como motivo»: sus palabras, tal cual. Sin palabras (en una sesión, o si solo dijo que le
 * duele) no hay motivo que ofrecer: el de la cita sigue como estaba.
 */
export function visitReasonForEncounter(answer: Pick<VisitAnswer, "reason">): string | null {
  const reason = answer.reason?.trim()
  return reason ? reason.slice(0, 2000) : null
}
