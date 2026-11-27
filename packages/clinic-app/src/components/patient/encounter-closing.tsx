import { formatMoney, sessionWords, showsSession } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  ScrollArea,
} from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  DatePickerButton,
  TimeSelect,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { Check } from "lucide-react"
import { useId, useRef, useState } from "react"
import { CLINICAL_NAME } from "../../lib/agent-names"
import type { FormResponse } from "../../lib/clinical-forms"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
import { hasRisksDraft, useRisksDrafts } from "../../lib/consent-risks-draft"
import { usePermission } from "../../lib/crm"
import type { ConsentNeed } from "../../lib/encounter-documents"
import {
  type BookedSession,
  CLOSING_REQUIREMENT_LABELS,
  type ClosingCheck,
  type ClosingControls,
  type ClosingDueControl,
  type ClosingMaterials,
  type ClosingNextControl,
  type ClosingRequirement,
  type ClosingResolvable,
  type ClosingSession,
  controlDaySaid,
  type FinishingControl,
  type FinishingControlChange,
  type HealthGap,
  keepsDiagnosis,
  type NextSession,
  type SignatureRegistration,
  signatureRegistrationErrors,
} from "../../lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { closingMaterialsWords } from "../../lib/materials"
import { productUi } from "../../product/product-ui"
import { whenSaid } from "../agenda/shared"
import { answersWords } from "./clio-form-proposals"
import type { DictationSuggestion } from "./dictation-session"
import { isOn } from "./dictation-sign-list"
import { isEmptyAnswer, missingRequired } from "./form-fields"

/**
 * Entre qué horas puede haber terminado la atención, en la zona de la clínica, y
 * de qué día: la de hoy, desde su inicio hasta ahora; la de otro día (la de una
 * cita pasada que se registra después), ese mismo día desde su inicio, porque
 * terminó cuando fue y no cuando se escribe. La lista («Hora», cada 15 minutos)
 * va dentro de esos límites.
 */
export function endTimeBounds(
  startedAt: string | null | undefined,
  now = new Date(),
): { min: string; max: string; day: string; past: boolean } {
  const nowValue = clinicDateTimeValue(now.toISOString())
  const today = nowValue.slice(0, 10)
  if (startedAt) {
    const startValue = clinicDateTimeValue(startedAt)
    const day = startValue.slice(0, 10)
    if (day < today) return { min: startValue.slice(11, 16), max: "23:59", day, past: true }
    if (day === today) return { min: startValue.slice(11, 16), max: nowValue.slice(11, 16), day, past: false }
  }
  return { min: "00:00", max: nowValue.slice(11, 16), day: today, past: false }
}

/** «¿Cuándo vuelve?»: nada elegido, uno de los atajos, «Otra fecha» o «No hace falta». */
export type NextControlChoice = "" | "week" | "month" | "recall" | "date" | "none"

/**
 * Lo que se escribe al cerrar: la hora de fin («HH:MM»; vacía = ahora), por qué
 * se sigue sin el consentimiento, si el perfil no la tiene, la colegiatura, y
 * cuándo vuelve la persona. Los nombres son los del cuerpo de `/finalize` y del
 * perfil profesional, para que cada rechazo del servidor caiga en su campo
 * (`endedAt` → `endTime`).
 */
export interface ClosingValues extends SignatureRegistration {
  endTime: string
  consentSkipReason: string
  /** Por qué firma sin su colegiatura en el perfil, si no la escribe aquí (17 nov). */
  registrationSkipReason: string
  /** «¿Cuándo vuelve?»: ninguno viene marcado. */
  nextControl: NextControlChoice
  /** El día de «Otra fecha» (`yyyy-MM-dd`). */
  nextControlDate: string
  /** Lo que se cambió de lo que viene marcado en «Cumple su control…», por control. */
  fulfill: Record<string, boolean>
  /**
   * Con un tratamiento en curso no se pregunta por un control; «Indicar también
   * un control» lo pregunta igual (una profilaxis terminada hoy junto a una
   * ortodoncia que sigue).
   */
  askControl?: boolean
  /**
   * Lo cambiado de los controles que dejan los tratamientos de hoy (`controls.finishing`), por su
   * `key`: otro día o quitarlo. Vale solo para esta persona.
   */
  finishChanges?: Record<string, { dueDay?: string; remove?: boolean }>
  /**
   * Los controles abiertos que el cierre sugería quitar (`open[].forSession`: eran para la próxima
   * sesión de lo que termina con esta firma) y quien firma quitó con «Quitar».
   */
  dropControls?: string[]
  /**
   * La consulta del cierre: vacío es la que viene marcada (`closing.consultation.proposed`),
   * «none» es desmarcada, o el servicio elegido con «Cambiar».
   */
  consultation?: string
}

/** Lo que se manda a `/finalize` de la consulta: la elegida, `null` si se desmarcó, nada si no hubo. */
export function consultationBody(
  value: Pick<ClosingValues, "consultation">,
  consultation: ClosingCheck["consultation"],
): { consultationServiceId?: string | null } {
  if (!consultation) return {}
  const choice = value.consultation ?? ""
  if (choice === "none") return { consultationServiceId: null }
  return { consultationServiceId: choice || consultation.proposed.serviceId }
}

/** Los datos de `/finalize` que la pantalla llama de otro modo. */
export const CLOSING_FIELD_MAP = { endedAt: "endTime", "nextControl.dueAt": "nextControlDate" } as const

const EMPTY_CLOSING: ClosingValues = {
  endTime: "",
  consentSkipReason: "",
  registrationSkipReason: "",
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
  nextControl: "",
  nextControlDate: "",
  fulfill: {},
  finishChanges: {},
  consultation: "",
}

/** Un control de Clío marcado para entrar con la firma: ya dice cuándo vuelve. */
export interface DictatedControl {
  id: string
  /** Su día (`yyyy-MM-dd`) en la zona de la clínica. */
  day: string
  /** Es la cita que dictó y entra con la firma, no un control (QA del 21 nov, C8). */
  appointment?: boolean
  /** Para qué vuelve, si se dijo: «la otra resina». */
  what?: string | null
}

/**
 * El control por cumplir queda cumplido con esta visita: lo marcado, o lo que
 * viene marcado si nadie lo tocó (el que indicó quien firma o el que se eligió al empezar).
 */
export function fulfills(
  value: Pick<ClosingValues, "fulfill">,
  control: ClosingDueControl,
): boolean {
  return value.fulfill[control.id] ?? (control.mine || control.chosen === true)
}

/** Lo que ya dice cuándo vuelve, sin preguntar: así no quedan dos controles. */
type KnownReturn =
  | ({ kind: "dictated" } & DictatedControl)
  | { kind: "repeats"; months: number }
  | { kind: "control"; control: ClosingNextControl }
  | { kind: "stays"; control: ClosingDueControl }

/**
 * La misma regla que el servidor (`finalizeEncounter`): se pregunta «¿Cuándo
 * vuelve?» salvo que Clío ya lo dictó, que el control que se cumple (por la
 * ventana o por la cita de esta atención) se repite, que ya tiene otro, o que
 * quien firma deja sin marcar uno suyo. Uno de un colega sin marcar no frena.
 */
function knownReturn(
  value: Pick<ClosingValues, "fulfill" | "dropControls">,
  controls: ClosingControls,
  dictated: DictatedControl | null,
): KnownReturn | null {
  if (dictated) return { kind: "dictated", ...dictated }
  const repeating =
    controls.due.find((control) => fulfills(value, control) && control.repeatEveryMonths) ??
    controls.byAppointment.find((control) => control.repeatEveryMonths)
  if (repeating?.repeatEveryMonths) return { kind: "repeats", months: repeating.repeatEveryMonths }
  // El que se quitó en «Controles que quedan» ya no dice cuándo vuelve: se pregunta.
  if (controls.next && !value.dropControls?.includes(controls.next.id)) return { kind: "control", control: controls.next }
  const stays = controls.due.find((control) => control.mine && !fulfills(value, control))
  return stays ? { kind: "stays", control: stays } : null
}

/** El día que queda con lo elegido (`yyyy-MM-dd`), o vacío. */
function chosenDay(value: Pick<ClosingValues, "nextControl" | "nextControlDate">, controls: ClosingControls): string {
  if (value.nextControl === "date") return value.nextControlDate
  if (value.nextControl === "week" || value.nextControl === "month" || value.nextControl === "recall")
    return controls.shortcuts[value.nextControl]
  return ""
}

/**
 * Un tratamiento que sigue en curso al firmar, con la sesión a la que vuelve:
 * lo que no llega a sus previstas y lo que se respondió «Falta otra sesión».
 */
export interface ContinuingVisit {
  planItemId: string
  /** «Endodoncia · 46». */
  label: string
  /** La sesión a la que vuelve y las previstas, ya con lo respondido. */
  n: number
  m: number
  booked?: BookedSession
  /** Lo aceptado sin empezar a lo que vuelve (la corona): lo de hoy ya terminó. */
  accepted?: boolean
  /** Con lo aceptado: lo que termina hoy («Endodoncia»), para nombrar su control. */
  after?: string
}

/**
 * Lo que sigue en curso si se firma con lo respondido (la regla del servidor,
 * `applySessionAnswers`): mientras algo sigue, «¿Cuándo vuelve?» es su próxima
 * sesión y no pregunta por un control (QA del 8 nov, X11).
 */
export function continuingAfterSign(
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[]; accepted?: ClosingSession[] } | null | undefined,
  answers: SessionAnswers,
  labelOf: (session: ClosingSession) => string = (session) => session.title,
): ContinuingVisit[] {
  if (!sessions) return []
  const visit = (session: ClosingSession, m: number): ContinuingVisit => ({
    planItemId: session.planItemId,
    label: labelOf(session),
    n: session.n + 1,
    m,
    ...(session.booked ? { booked: session.booked } : {}),
  })
  const going = [
    // Lo que aún no llega a sus previstas sigue, salvo que se responda «Sí, terminar».
    ...sessions.continuing
      .filter((session) => answers[session.planItemId] !== "terminar")
      .map((session) => visit(session, session.m)),
    ...sessions.finishing
      .filter((session) => answers[session.planItemId] === "otra")
      .map((session) => visit(session, Math.max(session.m, session.n) + 1)),
  ]
  // Si nada sigue en curso, vuelve para lo aceptado sin empezar (la corona tras la endodoncia):
  // no un control genérico que pedía otra cita (QA del 9 nov). La regla del servidor (`finalizeEncounter`).
  if (going.length > 0) return going
  const after =
    sessions.finishing.find((session) => answers[session.planItemId] !== "otra")?.title ??
    sessions.continuing.find((session) => answers[session.planItemId] === "terminar")?.title
  return (sessions.accepted ?? []).map((session) => ({
    ...visit(session, session.m),
    accepted: true,
    ...(after ? { after } : {}),
  }))
}

/**
 * Con algo ya ofrecido para volver (la corona tras la endodoncia, o la sesión 2
 * que sigue), el control que se pide aparte: su título, como lo nombra el
 * servidor al crearlo («Control de endodoncia»), y lo que queda con o sin plazo.
 * Sin nada ofrecido, null: se dice lo de siempre (QA del 9 nov: «No indicaste
 * cuándo vuelve» salía debajo de «Vuelve para…»).
 */
export function controlBesideAccepted(
  continuing: ContinuingVisit[],
  day: string,
): { title: string; line: string } | null {
  if (continuing.length === 0) return null
  const after = continuing.find((visit) => visit.after)?.after
  const names = continuing.map((visit) => `«${visit.label}»`)
  const what = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
  return {
    title: after ? `Control de ${inSentence(after)}` : "Control",
    line: day
      ? `Control hacia el ${controlDaySaid(day)} · recepción lo verá para reservarlo`
      : `Sin plazo, el control no queda anotado: solo ${what}.`,
  }
}

/** «el lun 9 a las 10:45», «mañana a las 17:00», en la zona de la clínica. */
export function visitWhenSaid(iso: string): string {
  const timeZone = activeOrgTimeZone()
  return whenSaid(iso, timeZone, zonedDateOf(new Date().toISOString(), timeZone))
}

/** «Resina · 15», «Resina · 15 y Limpieza», «Corona · 36, Resina · 15 y Limpieza»; vacío sin nada. */
export function listSaid(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}

/** «Endodoncia · 46 · sesión 2 de 2»; uno de una sola sesión, solo su nombre. */
export function sessionLine(label: string, n: number, m: number): string {
  return showsSession(n, m) ? `${label} · ${sessionWords(n, m)}` : label
}

/**
 * Lo que dice el cierre de la página, a quien ve la caja, cuando aún no hay cargos que estimar. Que
 * lo marcado «Hoy» se carga al registrarlo, solo si algo marcado y sin registrar todavía no tiene su
 * cargo: la sesión 2 de un cobro único ya cargado no carga nada (QA en pantalla del 17 nov, auditor
 * H3). `chargedIds` es lo de cobro único que ya tiene su cargo (`conCargo` de la cuenta).
 */
export function noNewChargesWords(input: {
  plannedIds: readonly string[]
  registeredIds: ReadonlySet<string>
  chargedIds: ReadonlySet<string>
  dayWord: string
  /** Lo registrado como hecho en la atención (sin lo anulado): sin nada, no hay «actos sin costo». */
  registeredCount?: number
  /** La consulta que el cierre propondrá cobrar («Evaluación odontológica · S/ 50.00»), si hay. */
  consultation?: string | null
}): string {
  const charges = input.plannedIds.some(
    (id) => !input.registeredIds.has(id) && !input.chargedIds.has(id),
  )
  if (!charges && input.plannedIds.length === 0 && input.registeredCount === 0)
    return input.consultation
      ? `Sin cargos todavía: al firmar se propone cobrar ${input.consultation}.`
      : "Sin cargos todavía: no hay nada registrado como hecho."
  return charges
    ? `Sin cargos nuevos por ahora: lo marcado «${input.dayWord}» se carga al registrarlo, según su presupuesto.`
    : "Sin cargos nuevos: actos sin costo o tratamientos ya cargados."
}

/** Falta el día de «Otra fecha»: lo dice su campo. Si sigue en curso, no se pregunta. */
export function needsNextControlDay(
  value: ClosingValues,
  controls: ClosingControls | null,
  dictated: DictatedControl | null,
  continuing = false,
): boolean {
  if (!controls || (continuing && !value.askControl) || value.nextControl !== "date" || value.nextControlDate) return false
  return !knownReturn(value, controls, dictated)
}

/**
 * Lo que el cierre manda de los controles: cuáles cumple esta visita y, si se
 * preguntó, cuándo vuelve. Con un tratamiento que sigue en curso no se pregunta:
 * vuelve a su próxima sesión.
 */
export function closingControlsBody(
  value: ClosingValues,
  controls: ClosingControls | null,
  dictated: DictatedControl | null,
  continuing = false,
): {
  followUpIds?: string[]
  nextControl?: { dueAt: string } | { none: true }
  finishControlChanges?: FinishingControlChange[]
  dropFollowUpIds?: string[]
} {
  if (!controls) return {}
  const followUpIds = controls.due.filter((control) => fulfills(value, control)).map((control) => control.id)
  const changes = finishingChanges(value, controls)
  // Solo los que el cierre sugería quitar; el servidor además mira que su tratamiento termine.
  const drop = (controls.open ?? [])
    .filter((control) => control.forSession && value.dropControls?.includes(control.id))
    .map((control) => control.id)
  const extra = {
    ...(changes.length > 0 ? { finishControlChanges: changes } : {}),
    ...(drop.length > 0 ? { dropFollowUpIds: drop } : {}),
  }
  if ((continuing && !value.askControl) || knownReturn(value, controls, dictated)) return { followUpIds, ...extra }
  if (value.nextControl === "none") return { followUpIds, nextControl: { none: true }, ...extra }
  const day = chosenDay(value, controls)
  return day ? { followUpIds, nextControl: { dueAt: day }, ...extra } : { followUpIds, ...extra }
}

/** Lo cambiado de los controles que van a quedar, como lo pide `/finalize`. */
function finishingChanges(value: Pick<ClosingValues, "finishChanges">, controls: ClosingControls): FinishingControlChange[] {
  return (controls.finishing ?? []).flatMap((control): FinishingControlChange[] => {
    const change = value.finishChanges?.[control.key]
    if (change?.remove) return [{ key: control.key, remove: true }]
    if (change?.dueDay && change.dueDay !== control.dueDay) return [{ key: control.key, dueDay: change.dueDay }]
    return []
  })
}

/**
 * «Controles que quedan» (decisión B5 del 10 nov): los que dejan los tratamientos que terminan al
 * firmar, cada uno con «Cambiar fecha» y «Quitar» (solo para esta persona), y los que ya tiene
 * abiertos, que se cambian en «Plan y controles» o moviendo su cita. Arriba de «¿Cuándo vuelve?».
 */
function ClosingControlsLeft({
  form,
  controls,
  busy,
  ends,
}: {
  form: ClosingForm
  controls: ClosingControls
  busy: boolean
  /** El tratamiento trabajado hoy termina con esta firma, con lo respondido en «¿Terminaste?». */
  ends: (planItemId: string) => boolean
}): React.JSX.Element | null {
  const ids = useId()
  const changes = useStore(form.store, (state) => state.values.finishChanges ?? {})
  const dropped = useStore(form.store, (state) => state.values.dropControls ?? [])
  const toggleDrop = (id: string, drop: boolean) =>
    form.setFieldValue("dropControls", drop ? [...dropped.filter((other) => other !== id), id] : dropped.filter((other) => other !== id))
  const finishing = controls.finishing ?? []
  const open = (controls.open ?? []).filter((control) => !controls.due.some((due) => due.id === control.id))
  if (finishing.length === 0 && open.length === 0) return null
  const tomorrow = dayOf(new Date(Date.now() + 86_400_000).toISOString())
  const set = (control: FinishingControl, next: { dueDay?: string; remove?: boolean } | null) => {
    const rest = { ...changes }
    if (next) rest[control.key] = next
    else delete rest[control.key]
    form.setFieldValue("finishChanges", rest)
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">Controles que quedan</p>
      <ul className="flex flex-col gap-2">
        {finishing.map((control) => {
          const change = changes[control.key]
          const day = change?.dueDay || control.dueDay
          const editing = change?.dueDay !== undefined && !change.remove
          return (
            <li key={control.key} className="flex flex-col gap-1.5 rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className={change?.remove ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                  {control.title}
                  <span className="text-muted-foreground"> · {controlDaySaid(day)}</span>
                </span>
                <span className="flex gap-1">
                  {change?.remove ? (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => set(control, null)}>
                      Deshacer
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-expanded={editing}
                        onClick={() => set(control, editing ? null : { dueDay: day })}
                      >
                        {editing ? "Dejar la sugerida" : "Cambiar fecha"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => set(control, { remove: true })}
                      >
                        Quitar
                      </Button>
                    </>
                  )}
                </span>
              </div>
              {editing ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${ids}-${control.key.replace(/[^\w-]/g, "_")}`} className="text-xs text-muted-foreground">
                    Día del control
                  </label>
                  <DatePickerButton
                    id={`${ids}-${control.key.replace(/[^\w-]/g, "_")}`}
                    className="w-56"
                    min={tomorrow}
                    openAt={day}
                    disabled={busy}
                    value={day}
                    onChange={(next: string) => set(control, { dueDay: next })}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
        {open.map((control) => {
          // El que era para la próxima sesión de lo que termina con esta firma: se sugiere quitarlo
          // en su fila, como los de arriba; quien firma decide (QA del 26 nov, H6).
          const stale = control.forSession && !control.scheduledAt && ends(control.forSession.planItemId) ? control.forSession : null
          if (!stale)
            return (
              <li key={control.id} className="rounded-md border px-3 py-2 text-sm">
                {control.title}
                <span className="text-muted-foreground">
                  {control.scheduledAt
                    ? ` · con su cita el ${controlDaySaid(dayOf(control.scheduledAt))}: se cambia moviendo la cita`
                    : ` · ${controlDaySaid(dayOf(control.dueAt))} · se cambia en Plan y controles`}
                </span>
              </li>
            )
          const removed = dropped.includes(control.id)
          return (
            <li key={control.id} className="flex flex-col gap-1 rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className={removed ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                  {control.title}
                  <span className="text-muted-foreground"> · {controlDaySaid(dayOf(control.dueAt))}</span>
                </span>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => toggleDrop(control.id, !removed)}>
                  {removed ? "Deshacer" : "Quitar"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{staleControlSaid(stale)}</p>
            </li>
          )
        })}
      </ul>
      {finishing.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Los sugiere su servicio y quedan al firmar. Lo que cambies o quites vale solo para esta persona.
        </p>
      ) : null}
    </div>
  )
}

const ORDINAL_WORDS = ["primera", "segunda", "tercera", "cuarta", "quinta", "sexta", "séptima", "octava", "novena", "décima"]

/**
 * «Sugerencia: la endodoncia termina con esta firma; este control era para su segunda sesión.» El
 * artículo va por la primera palabra del tratamiento: las en -a, -dad, -ión o -sis, «la».
 */
export function staleControlSaid(forSession: { title: string; session: number }): string {
  const name = inSentence(forSession.title.split(" · ")[0] ?? forSession.title)
  const first = (name.split(" ")[0] ?? "").toLocaleLowerCase("es")
  const article = /(a|dad|i[oó]n|sis)$/.test(first) ? "la" : "el"
  const which = ORDINAL_WORDS[forSession.session - 1]
  return `Sugerencia: ${article} ${name} termina con esta firma; este control era para su ${which ? `${which} sesión` : `sesión ${forSession.session}`}.`
}

/** El día de un instante en la zona de la clínica. */
const dayOf = (iso: string): string => clinicDateTimeValue(iso).slice(0, 10)

/** «Control de mantenimiento» → «control de mantenimiento», para decirlo en una frase. */
const inSentence = (title: string): string => (/^\p{Lu}\p{Ll}/u.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title)

/**
 * Un atajo: botón con borde, que se lee como botón también a 390 px; lo
 * elegido lleva el fondo de la acción y un check, no solo otro relieve.
 */
const CHIP =
  "h-auto min-h-11 gap-1.5 rounded-full border border-input bg-background px-3.5 py-1.5 text-sm font-normal text-foreground shadow-none hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary sm:min-h-9"

/**
 * «¿Cuándo vuelve?» al firmar (ADR 0152), justo antes de firmar: los controles
 * que esta visita cumple, como casillas (marcado solo el de quien firma), y los
 * atajos para el próximo. Ninguno viene marcado y se firma igual sin elegir.
 * Si ya tiene un control (o Clío dictó uno), dice cuándo vuelve, sin cambiarlo
 * aquí: eso se hace en «Plan y controles». Si un tratamiento sigue en curso,
 * vuelve a su próxima sesión: la dice (con su cita, si ya la tiene) y no
 * pregunta por un control, que se indica en la sesión en que termine.
 */
export function ClosingNextVisit({
  form,
  controls,
  dictated = null,
  busy,
  continuing = [],
  canBook = true,
  afterUnbooked = [],
}: {
  form: ClosingForm
  controls: ClosingControls | null | undefined
  /** El control de Clío marcado para entrar con la firma, si hay. */
  dictated?: DictatedControl | null
  busy: boolean
  /** Lo que sigue en curso al firmar (`continuingAfterSign`). */
  continuing?: ContinuingVisit[]
  /** Quien firma puede reservar la cita: se le dice que la reserva al firmar. */
  canBook?: boolean
  /**
   * Lo que iba después de lo que hoy termina y aún no tiene cita («Corona · 36»): se propone un
   * control a 30 días, sin marcarlo (estudio de la atención, 16 nov).
   */
  afterUnbooked?: string[]
}): React.JSX.Element | null {
  const ids = useId()
  const values = useStore(form.store, (state) => state.values)
  if (!controls) return null
  const known = knownReturn(values, controls, dictated)
  const booked = continuing.flatMap((visit) =>
    visit.booked
      ? [`Vuelve ${visitWhenSaid(visit.booked.startsAt)} para ${sessionLine(visit.label, visit.booked.n, visit.booked.m)}, con su cita.`]
      : [],
  )
  // Lo que no tiene cita va en una sola frase: «Vuelve para Resina · 15 y Limpieza».
  const unbooked = continuing.filter((visit) => !visit.booked)
  const unbookedWhat = listSaid(unbooked.map((visit) => sessionLine(visit.label, visit.n, visit.m)))
  // Las mismas palabras en los tres productos: en latidIA y vistIA lo indicado ya queda aceptado.
  const unbookedLine = !unbookedWhat
    ? null
    : canBook
      ? `Vuelve para ${unbookedWhat}: al firmar puedes reservar su cita aquí mismo.`
      : `Vuelve para ${unbookedWhat}: recepción la verá en «Qué sigue» para reservarla.`
  const sessionsLines = [...booked, ...(unbookedLine ? [unbookedLine] : [])]
  // El control corto que se propone, sin marcarlo: quien firma decide.
  const proposal =
    afterUnbooked.length > 0 && !known && values.nextControl !== "month"
      ? `${listSaid(afterUnbooked)} ${afterUnbooked.length === 1 ? "va después de lo que hoy termina y aún no tiene cita" : "van después de lo que hoy termina y aún no tienen cita"}: conviene un control en 1 mes.`
      : null
  const proposeMonth = () => {
    set("askControl", true)
    set("nextControl", "month")
  }
  const recall = controls.recallMonths
  const options: Array<{ value: Exclude<NextControlChoice, "" | "none">; label: string }> = [
    { value: "week", label: "En 1 semana" },
    { value: "month", label: "En 1 mes" },
    { value: "recall", label: recall === 12 ? "En 1 año" : `En ${recall} meses` },
    { value: "date", label: "Otra fecha" },
  ]
  const tomorrow = dayOf(new Date(Date.now() + 86_400_000).toISOString())
  const set = <K extends keyof ClosingValues>(name: K, value: ClosingValues[K]) => form.setFieldValue(name, value as never)
  const day = chosenDay(values, controls)
  const none = values.nextControl === "none"
  // Pedido aparte de lo aceptado que ya se ofrece (la corona): se nombra como control.
  const beside = values.askControl ? controlBesideAccepted(continuing, day) : null
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <ClosingControlsLeft
        form={form}
        controls={controls}
        busy={busy}
        ends={(planItemId) => !continuing.some((visit) => visit.planItemId === planItemId && !visit.accepted)}
      />
      {/* El control que trae su cita de hoy se cumple al firmar: se dice cuál y de quién (QA del 9 nov, repaso 3). */}
      {controls.byAppointment.map((control) => (
        <p key={control.id} className="text-sm">
          Se cumple su {inSentence(control.title)}
          {control.byName ? `, que indicó ${control.byName}` : ""}: era su cita de hoy.
        </p>
      ))}
      {controls.due.length > 0 ? (
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="mb-0">
            {controls.due.length === 1 ? "Su control" : "Sus controles"}
          </FieldLegend>
          <FieldGroup className="gap-2">
            {controls.due.map((control) => (
              <Field key={control.id} orientation="horizontal">
                <Checkbox
                  id={`${ids}-cumple-${control.id}`}
                  checked={fulfills(values, control)}
                  disabled={busy}
                  onCheckedChange={(checked) => set("fulfill", { ...values.fulfill, [control.id]: checked === true })}
                />
                <FieldLabel htmlFor={`${ids}-cumple-${control.id}`} className="font-normal">
                  Cumple su {inSentence(control.title)} del {controlDaySaid(dayOf(control.dueAt))}
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
          <FieldDescription>
            Por qué: cualquier atención desde unos días antes de su fecha le sirve. Viene marcado si
            lo indicaste tú o si dijiste que viene a él.
          </FieldDescription>
        </FieldSet>
      ) : null}
      <div className="flex flex-col gap-2">
        <p id={`${ids}-cuando`} className="font-medium">
          ¿Cuándo vuelve?
        </p>
        {sessionsLines.map((line, index) => (
          <p key={`${index}-${line}`} className="text-sm">
            {line}
          </p>
        ))}
        {sessionsLines.length > 0 && !known && !values.askControl && proposal ? (
          <p className="text-xs text-muted-foreground">
            {proposal}{" "}
            <Button
              type="button"
              size="sm"
              variant="link"
              className="h-auto p-0 text-xs"
              disabled={busy}
              onClick={proposeMonth}
            >
              Indicar el control en 1 mes
            </Button>
          </p>
        ) : sessionsLines.length > 0 && !known && !values.askControl ? (
          <p className="text-xs text-muted-foreground">
            {/* Lo de hoy terminó (la endodoncia): su control se indica ahora, si hace falta (segunda mesa del 9 nov). */}
            {continuing.every((visit) => visit.accepted)
              ? controls.finishing?.length
                ? "Lo de hoy queda terminado: si además necesita otro control, indícalo también."
                : "Lo de hoy queda terminado: si necesita su control, indícalo también."
              : "El control se indica en la sesión en que termine."}{" "}
            <Button
              type="button"
              size="sm"
              variant="link"
              className="h-auto p-0 text-xs"
              disabled={busy}
              onClick={() => set("askControl", true)}
            >
              Indicar también un control
            </Button>
          </p>
        ) : known ? (
          <p className="text-sm">
            {known.kind === "dictated"
              ? known.appointment
                ? `Vuelve el ${controlDaySaid(known.day)}${known.what ? ` para ${known.what}` : ""}, con la cita que dictaste.`
                : `Vuelve el ${controlDaySaid(known.day)}, como dictaste.`
              : known.kind === "repeats"
                ? `Su control se repite: el siguiente queda para ${recallWords(known.months)}.`
                : known.kind === "stays"
                  ? `Sigue pendiente su ${inSentence(known.control.title)} del ${controlDaySaid(dayOf(known.control.dueAt))}: recepción lo verá.`
                  : known.control.scheduledAt
                    ? `Vuelve el ${controlDaySaid(dayOf(known.control.scheduledAt))}, con su cita.`
                    : `Vuelve el ${controlDaySaid(dayOf(known.control.dueAt))}.`}
          </p>
        ) : (
          <>
            {beside ? (
              <p id={`${ids}-control`} className="text-sm font-medium">
                {beside.title}
              </p>
            ) : null}
            {proposal ? (
              <p className="text-sm">
                {proposal}{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="h-auto p-0"
                  disabled={busy}
                  onClick={proposeMonth}
                >
                  Indicar el control en 1 mes
                </Button>
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <ToggleGroup
                aria-labelledby={beside ? `${ids}-control` : `${ids}-cuando`}
                value={values.nextControl && !none ? [values.nextControl] : []}
                onValueChange={(next: unknown[]) => {
                  const picked = next[0]
                  set("nextControl", typeof picked === "string" ? (picked as NextControlChoice) : "")
                }}
                disabled={busy}
                spacing={2}
                className="flex-wrap"
              >
                {options.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value} className={CHIP}>
                    {values.nextControl === option.value ? <Check aria-hidden className="size-4" /> : null}
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {/* «No hace falta» no es una fecha: va aparte. */}
              <span aria-hidden className="hidden h-6 w-px bg-border sm:block" />
              <Button
                type="button"
                variant="outline"
                aria-pressed={none}
                disabled={busy}
                className={`${CHIP} self-start`}
                onClick={() => set("nextControl", none ? "" : "none")}
              >
                {none ? <Check aria-hidden className="size-4" /> : null}
                No hace falta
              </Button>
            </div>
            {values.nextControl === "date" ? (
              <form.AppField name="nextControlDate">
                {(field) => (
                  <field.Control label="Día en que vuelve">
                    {(control) => (
                      <DatePickerButton
                        {...control.props}
                        className="w-56"
                        min={tomorrow}
                        openAt={controls.shortcuts.recall}
                        disabled={busy}
                        value={field.state.value}
                        onChange={field.handleChange}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ) : null}
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {none
                ? "Queda dicho que no hace falta otro control."
                : values.nextControl === "date" && !day
                  ? "Elige el día en el calendario."
                  : beside
                    ? beside.line
                    : day && (controls.returnsTo?.length ?? 0) > 0 && day <= controls.shortcuts.month
                      ? // Vuelve para lo que falta hacer, no a un control aparte (QA del 10 nov, M6 y B7).
                        `Vuelve hacia el ${controlDaySaid(day)} para ${joinTitles(controls.returnsTo ?? [])} · recepción lo verá en «Qué sigue»`
                      : day
                        ? `Vuelve hacia el ${controlDaySaid(day)} · recepción lo verá para reservarlo`
                        : "No indicaste cuándo vuelve: recepción no lo verá"}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** «la exodoncia simple y la resina»: lo que falta hacer, en una frase. */
function joinTitles(titles: readonly string[]): string {
  const lowered = titles.map((title) => title.charAt(0).toLowerCase() + title.slice(1))
  if (lowered.length <= 1) return lowered[0] ?? ""
  return `${lowered.slice(0, -1).join(", ")} y ${lowered.at(-1)}`
}

/**
 * Seguir sin el consentimiento de algo que se hizo hoy: el motivo se escribe siempre (17 nov: «los
 * motivos siempre se escriben»), sin atajos de un toque. Lo firmado en papel no es un motivo: se
 * sube la hoja con «Firmado en papel» en su fila. Lo indicado para otro día nunca llega aquí: se
 * firma antes de hacerlo. El motivo queda en la atención para siempre; una firma posterior se
 * agrega con su fecha.
 */
function ConsentSkipReason({ form, disabled }: { form: ClosingForm; disabled: boolean }): React.JSX.Element {
  return (
    <form.AppField name="consentSkipReason">
      {(field) => (
        <field.TextareaField
          label="Se hizo hoy sin el consentimiento firmado: escribe por qué"
          rows={2}
          maxLength={2000}
          disabled={disabled}
        />
      )}
    </form.AppField>
  )
}

/** «dentro de 6 meses», «dentro de 1 año». */
function recallWords(months: number): string {
  return months === 12 ? "dentro de 1 año" : months === 1 ? "dentro de 1 mes" : `dentro de ${months} meses`
}

/**
 * El formulario del cierre, el mismo para «Finalizar y firmar» y para firmar
 * con lo dictado. Lo escrito se conserva si el cierre falla; se vacía al
 * abrirlo de nuevo después de uno correcto (`form.reset`).
 */
export function useClosingForm(options: {
  /**
   * Hay consentimientos sin firmar y se cierra desde aquí: se pide por qué se
   * sigue sin ellos. Se lee al enviar (firmar con lo dictado no lo pide).
   */
  needsReason: () => boolean
  /** El perfil no tiene colegiatura: se escribe aquí, o el motivo para firmar sin ella. */
  needsRegistration: boolean
  /** «Otra fecha» sin día: se pide en su campo. Se lee al enviar. */
  needsNextDay?: (value: ClosingValues) => boolean
  onSubmit: (value: ClosingValues) => Promise<void>
}) {
  const latest = useRef(options)
  latest.current = options
  return useAppForm({
    defaultValues: EMPTY_CLOSING,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (latest.current.needsReason() && !value.consentSkipReason.trim())
          fields.consentSkipReason = "Escribe por qué sigues sin el consentimiento, o fírmalo ahora"
        // Sin colegiatura en el perfil: o la escribe (y va completa) o escribe por qué firma sin ella.
        if (latest.current.needsRegistration) {
          if (value.registrationNumber.trim()) Object.assign(fields, signatureRegistrationErrors(value))
          else if (!value.registrationSkipReason.trim())
            fields.registrationSkipReason = "Escribe tu colegiatura, o por qué firmas sin ella"
        }
        if (latest.current.needsNextDay?.(value)) fields.nextControlDate = "Elige el día en que vuelve, o uno de los atajos"
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: ({ value }) => latest.current.onSubmit(value),
  })
}

export type ClosingForm = ReturnType<typeof useClosingForm>

function consentLine(need: ConsentNeed, who: string): { title: string; detail: string } {
  if (need.status === "sin_publicar")
    return {
      title: `Esta clínica aún no activó el consentimiento de «${need.title}»`,
      detail: "Fírmalo en papel y súbelo, o sigue sin él diciendo por qué",
    }
  if (need.status === "sin_preparar")
    return {
      title: `Falta el consentimiento de «${need.title}»`,
      detail: "Puedes firmarlo ahora o seguir sin él, diciendo por qué",
    }
  if (need.personSigned)
    return {
      title: `«${need.title}»: lo firmó desde su enlace y falta confirmarlo`,
      detail: "Confírmalo si ya le informaste, o sigue sin él diciendo por qué",
    }
  return {
    title: `Falta la firma de ${who} en «${need.title}»`,
    detail: "Puedes firmarlo ahora o seguir sin él, diciendo por qué",
  }
}

/**
 * Un solo cierre (decisión 3): con quién se firma, el consentimiento sin firmar
 * (firmarlo ahora o seguir sin él diciendo por qué), lo que dice el producto
 * (odentIA: el odontograma que queda firmado y el periodontograma), los
 * materiales que salen de la sede (una línea que informa), la hora de fin y,
 * después de firmar, lo que quedó por cobrar. Si el cierre falla, el diálogo
 * sigue abierto: cada rechazo en su campo, lo que falta registrar con su
 * «Registrar» y lo demás junto a los botones.
 */
/**
 * Donde quien atiende agrega o cambia su firma (ADR 0131): quien atiende no entra a
 * Configuración, y el cierre es donde firma todos los días. Avisa, no impide cerrar.
 */
export function ClosingSignatureHint({
  saved,
  onEdit,
}: {
  saved: boolean
  onEdit: () => void
}): React.JSX.Element {
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {saved
        ? "Tus papeles llevan la firma que guardaste. "
        : "Sin tu firma guardada, tus papeles salen con una línea para firmar a mano. "}
      <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" onClick={onEdit}>
        {saved ? "Cambiar mi firma" : "Agregar mi firma"}
      </Button>
    </p>
  )
}

/**
 * Dónde guarda este navegador lo escrito en el cierre hasta firmar: por atención y por quien lo
 * escribe. En una computadora compartida, lo de otra persona (su colegiatura) no se abre en el
 * cierre de quien entra después ni llega a su perfil al firmar (revisión del 17 nov).
 */
export function closingDraftKeyOf(encounterId: string, userId: string): string {
  return `odentia:cierre:${userId}:${encounterId}`
}

/**
 * Lo que se respondió a «¿Terminaste?» de cada tratamiento. En lo que llega a sus
 * sesiones previstas, sin respuesta vale «Sí, terminar»: es lo que viene elegido y lo
 * que hace el servidor (ADR 0161). En lo que aún no llega, sin respuesta sigue en curso
 * («otra»): solo «terminar» lo deja realizado antes.
 */
export type SessionAnswers = Record<string, "terminar" | "otra">

/**
 * Lo respondido, como lo pide la firma (`applySessionAnswers`): «Falta otra sesión» de
 * lo que llega a sus previstas y «Sí, terminar» de lo que aún no llega. Solo de lo que
 * el cierre preguntó.
 */
export function sessionAnswersBody(
  answers: SessionAnswers,
  sessions:
    | { finishing: Array<{ planItemId: string }>; continuing?: Array<{ planItemId: string }> }
    | null
    | undefined,
): { addSessionPlanItemIds?: string[]; completePlanItemIds?: string[] } {
  const finishing = new Set((sessions?.finishing ?? []).map((session) => session.planItemId))
  const continuing = new Set((sessions?.continuing ?? []).map((session) => session.planItemId))
  const addSession = Object.entries(answers).flatMap(([id, chosen]) =>
    chosen === "otra" && finishing.has(id) ? [id] : [],
  )
  const complete = Object.entries(answers).flatMap(([id, chosen]) =>
    chosen === "terminar" && continuing.has(id) ? [id] : [],
  )
  return {
    ...(addSession.length ? { addSessionPlanItemIds: addSession } : {}),
    ...(complete.length ? { completePlanItemIds: complete } : {}),
  }
}

/**
 * Lo trabajado hoy de un tratamiento, una línea por cada uno. Lo que con esta
 * atención llega a sus sesiones previstas pregunta «¿Terminaste?» con «Sí,
 * terminar» ya elegido y «Falta otra sesión» a un toque, y dice debajo qué
 * pasará al firmar. Lo que aún no llega pregunta lo mismo con «Sigue en curso»
 * elegido: terminarlo antes es «Sí, terminar», aquí y no en otra parte (mesa del
 * 17 nov). El mismo bloque va en el cierre y al firmar con lo dictado.
 */
export function ClosingSessions({
  sessions,
  labelOf,
  answers,
  onAnswer,
  disabled,
  resolvable = [],
  keepDiagnoses,
  onKeepDiagnosis,
  part = "all",
}: {
  /**
   * En el diálogo de firmar, lo que se decide va primero y lo que solo se lee, después (QA del 16
   * nov, Q18): `decide` son «¿Terminaste?» (también lo que sigue en curso), lo que no se registró y
   * lo que queda resuelto; `read` hoy no tiene nada propio. Sin decirlo, todo junto.
   */
  part?: "all" | "decide" | "read"
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[]; notRegistered?: ClosingSession[] }
  labelOf: (session: ClosingSession) => string
  answers: SessionAnswers
  onAnswer: (planItemId: string, answer: "terminar" | "otra") => void
  disabled: boolean
  /** Los diagnósticos que resuelve lo que hoy termina (`closing.resolvable`). */
  resolvable?: ClosingResolvable[]
  /** Los que quien firma desmarcó: siguen activos. */
  keepDiagnoses?: ReadonlySet<string>
  /** Sin él, solo se informa. */
  onKeepDiagnosis?: (diagnosisIds: string[], keep: boolean) => void
}): React.JSX.Element | null {
  const ids = useId()
  const decides = part !== "read"
  const finishing = decides ? sessions.finishing : []
  // Lo que sigue en curso también se responde (¿Terminaste?): va con lo que se decide.
  const continuing = decides ? sessions.continuing : []
  const notRegistered = decides ? (sessions.notRegistered ?? []) : []
  const resolving = decides ? resolvingOnSign(resolvable, sessions, answers) : []
  if (finishing.length === 0 && continuing.length === 0 && notRegistered.length === 0 && resolving.length === 0)
    return null
  // Una resina de una sesión no dice «sesión 1 de 1»: solo su nombre.
  const line = (session: ClosingSession) =>
    showsSession(session.n, session.m) ? `${labelOf(session)} · ${sessionWords(session.n, session.m)}` : labelOf(session)
  // Al preguntar «¿Terminaste?» sí: «sesión 1 de 1» deja ver que se previó una sola y,
  // si eran dos, «Falta otra sesión» está al lado (QA del 9 nov: la endodoncia de dos
  // sesiones indicada con una venía en «Sí, terminar» sin decirlo).
  const asked = (session: ClosingSession) => `${labelOf(session)} · ${sessionWords(session.n, session.m)}`
  const choices = [
    { value: "terminar", label: "Sí, terminar" },
    { value: "otra", label: "Falta otra sesión" },
  ] as const
  const continuingChoices = [
    { value: "otra", label: "Sigue en curso" },
    { value: "terminar", label: "Sí, terminar" },
  ] as const
  return (
    <ul
      aria-label={part === "read" ? "Tratamientos que siguen en curso" : "Tratamientos de hoy"}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      {finishing.map((session, index) => {
        const answer = answers[session.planItemId] ?? "terminar"
        const labelId = `${ids}-terminaste-${index}`
        return (
          <li key={session.planItemId} className="flex flex-col gap-2">
            <span id={labelId}>
              <span className="font-medium">{asked(session)}</span> · ¿Terminaste?
            </span>
            {/* Siempre hay una elegida: tocar la elegida no la desmarca. */}
            <ToggleGroup
              aria-labelledby={labelId}
              value={[answer]}
              onValueChange={(next: unknown[]) => {
                const picked = next[0]
                if (picked === "terminar" || picked === "otra") onAnswer(session.planItemId, picked)
              }}
              disabled={disabled}
              spacing={2}
              className="flex-wrap"
            >
              {choices.map((choice) => (
                <ToggleGroupItem key={choice.value} value={choice.value} className={CHIP}>
                  {answer === choice.value ? <Check aria-hidden className="size-4" /> : null}
                  {choice.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {answer === "terminar"
                ? "Al firmar queda realizado."
                : `Sigue en curso con una sesión más, la ${session.n + 1}: al firmar puedes reservarla.`}
            </p>
            {answer === "terminar" ? <DrawnOnSign session={session} /> : null}
          </li>
        )
      })}
      {/* Lo que aún no llega a sus previstas también pregunta, con «Sigue en curso» elegido: si sus
          sesiones habituales eran más de las que hizo falta, terminarlo es un toque aquí mismo. */}
      {continuing.map((session, index) => {
        const answer = answers[session.planItemId] === "terminar" ? "terminar" : "otra"
        const labelId = `${ids}-sigue-${index}`
        return (
          <li key={session.planItemId} className="flex flex-col gap-2">
            <span id={labelId}>
              <span className="font-medium">{asked(session)}</span> · ¿Terminaste?
            </span>
            <ToggleGroup
              aria-labelledby={labelId}
              value={[answer]}
              onValueChange={(next: unknown[]) => {
                const picked = next[0]
                if (picked === "terminar" || picked === "otra") onAnswer(session.planItemId, picked)
              }}
              disabled={disabled}
              spacing={2}
              className="flex-wrap"
            >
              {continuingChoices.map((choice) => (
                <ToggleGroupItem key={choice.value} value={choice.value} className={CHIP}>
                  {answer === choice.value ? <Check aria-hidden className="size-4" /> : null}
                  {choice.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {answer === "terminar"
                ? `Al firmar queda realizado, en la sesión ${session.n} de ${session.m}.`
                : `Sigue en curso: le queda la sesión ${session.n + 1}.`}
            </p>
            {answer === "terminar" ? <DrawnOnSign session={session} /> : null}
          </li>
        )
      })}
      {/* Avisa, no frena: quizá hoy no se pudo hacer. */}
      {notRegistered.map((session) => (
        <li key={session.planItemId} className="text-muted-foreground">
          Venía a {line(session)} y no registraste su sesión: si la hiciste, regístrala en el plan,
          en su fila.
        </li>
      ))}
      {/* Lo que el tratamiento terminado resuelve: marcado, se desmarca si no (QA del 9 nov). */}
      {resolving.map((found) => {
        const kept = keepsDiagnosis(found, keepDiagnoses ?? new Set())
        const checkboxId = `${ids}-resuelve-${found.diagnosisIds[0]}`
        return (
          <li key={found.diagnosisIds.join(",")} className="flex items-start gap-2">
            <Checkbox
              id={checkboxId}
              checked={!kept}
              disabled={disabled || !onKeepDiagnosis}
              // Lo que sana en su control se guarda como «tocado» al marcarlo; lo demás, al desmarcarlo.
              onCheckedChange={(checked) =>
                onKeepDiagnosis?.(found.diagnosisIds, found.followUp ? checked === true : checked !== true)
              }
            />
            <label htmlFor={checkboxId} className="leading-snug">
              {found.label}
              {found.site ? ` · ${found.site}` : ""} pasa a resuelto
              <span className="block text-xs text-muted-foreground">
                {found.followUp
                  ? "Una lesión periapical se da por sanada en su control con radiografía: márcalo solo si ya sanó."
                  : `Lo resuelve ${labelOfPlanItem(found.planItemIds, sessions, labelOf)}. Desmárcalo si sigue activo.`}
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

/** «En la 46 se dibuja: …»: lo que firmar deja en el odontograma al terminarlo. */
export function drawnOnSignText(drawn: { toothNumber: number; words: string }): string {
  return `En la ${drawn.toothNumber} se dibuja: ${drawn.words}. Si no es así, corrígelo en el odontograma.`
}

/**
 * Lo que firmar dibuja al dejarlo realizado (revisión del 26 nov): antes se dibujaba dentro de la
 * firma sin verse. Solo si el producto lo dice (odentIA).
 */
function DrawnOnSign({ session }: { session: ClosingSession }): React.JSX.Element | null {
  if (!session.draws) return null
  return <p className="text-xs text-muted-foreground">{drawnOnSignText(session.draws)}</p>
}

/**
 * Los diagnósticos que quedan resueltos al firmar con lo respondido: los de lo
 * que termina (o ya terminó hoy), no los de lo que sigue en curso.
 */
export function resolvingOnSign(
  resolvable: readonly ClosingResolvable[],
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[] } | null | undefined,
  answers: SessionAnswers,
): ClosingResolvable[] {
  // Basta un tratamiento que termine (o que ya terminó hoy): lo mismo que mira el servidor al firmar.
  const ends = (planItemId: string) => {
    // Lo que aún no llega a sus previstas termina solo con «Sí, terminar».
    if (sessions?.continuing.some((session) => session.planItemId === planItemId))
      return answers[planItemId] === "terminar"
    const finishing = sessions?.finishing.some((session) => session.planItemId === planItemId)
    return !finishing || (answers[planItemId] ?? "terminar") === "terminar"
  }
  return resolvable.filter((found) => found.planItemIds.some(ends))
}

/** «la endodoncia · 46»: el nombre del tratamiento, como en «¿Terminaste?». */
function labelOfPlanItem(
  planItemIds: readonly string[],
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[] },
  labelOf: (session: ClosingSession) => string,
): string {
  const session = sessions.finishing.find((row) => planItemIds.includes(row.planItemId))
  return session ? inSentence(labelOf(session)) : "el tratamiento de hoy"
}

/**
 * En «Atención finalizada», lo que sigue en curso con su próxima sesión, y
 * «Reservar la sesión 2» ahí mismo (propuesta 2 de la QA del 8 nov): abre
 * «Nueva cita» con esos tratamientos y su servicio, sin salir de la atención.
 * Reservar es opcional; lo que quede sin cita lo ve recepción en «Qué sigue».
 */
export function FinalizedNextSessions({
  sessions,
  labelOf,
  listRef,
  canBook,
  onBook,
  nameOf,
}: {
  sessions: NextSession[]
  /** «Endodoncia · 46». */
  labelOf: (session: NextSession) => string
  /** El nombre de quien atiende la cita (nulo si no es del equipo): lo reservado dice con quién. */
  nameOf: (userId: string) => string | null | undefined
  /** Recibe el foco al reservar: el botón que abrió la reserva ya no está. */
  listRef?: React.Ref<HTMLUListElement>
  canBook: boolean
  onBook: (planItemIds: string[]) => void
}): React.JSX.Element | null {
  if (sessions.length === 0) return null
  // Sin nombre conocido no se dice «con …»: nunca «con Profesional fuera del equipo».
  const withWhom = (booked: BookedSession) => {
    const name = booked.professionalName ?? nameOf(booked.professionalUserId)
    return name ? ` con ${name}` : ""
  }
  const toBook = sessions.filter((session) => session.toBook)
  const only = toBook.length === 1 ? toBook[0]?.toBook : null
  return (
    <section aria-label="Próxima sesión" className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      {/* Lo que falta y lo que ya quedó no se dicen igual (segunda mesa). */}
      <h3 className="text-sm font-semibold">{toBook.length > 0 ? "Falta reservar su próxima sesión" : "Su próxima sesión"}</h3>
      {/* Lo reservado aquí cambia en su sitio y se anuncia. */}
      <ul ref={listRef} tabIndex={-1} aria-live="polite" className="flex flex-col gap-1 text-sm outline-none">
        {sessions.map((session) =>
          session.booked ? (
            <li key={session.planItemId} className="flex items-baseline gap-1.5">
              <Check aria-hidden className="size-4 shrink-0 self-center text-success" />
              <span>
                Vuelve {visitWhenSaid(session.booked.startsAt)}
                {withWhom(session.booked)} para{" "}
                {sessionLine(labelOf(session), session.booked.n, session.booked.m)}.
              </span>
            </li>
          ) : session.toBook ? (
            <li key={session.planItemId}>
              {sessionLine(labelOf(session), session.toBook.n, session.toBook.m)} · sin cita
            </li>
          ) : null,
        )}
      </ul>
      {toBook.length > 0 && canBook ? (
        <Button
          type="button"
          className="self-start"
          onClick={() => onBook(toBook.map((session) => session.planItemId))}
        >
          {/* La primera de algo que aún no empieza (la corona) no es «la sesión 1»: es su cita. */}
          {only && showsSession(only.n, only.m) && only.n > 1 ? `Reservar la sesión ${only.n}` : "Reservar su próxima cita"}
        </Button>
      ) : toBook.length > 0 ? (
        <p className="text-xs text-muted-foreground">Recepción la verá en «Qué sigue» para reservarla.</p>
      ) : null}
    </section>
  )
}

const HEALTH_GAP_WORDS: Record<Exclude<HealthGap, "asa">, string> = {
  allergies: "sus alergias",
  conditions: "sus enfermedades",
  medications: "su medicación",
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} y ${words[words.length - 1]}`
}

/**
 * Si «Sin registrar: odontograma» sobra al cerrar: cuando el cierre lo firma (decía a la vez «queda
 * firmado» y «Sin registrar», QA del 9 nov) o en la sesión que solo trata (la 2 de la endodoncia),
 * que no firma copia porque ya tiene su odontograma firmado y lo tratado queda en el gráfico y en la
 * atención firmada. En la primera atención, sin odontograma firmado antes, se recuerda aunque haya
 * procedimientos (reglas clínicas, 18 nov).
 */
export function odontogramReminderCovered(input: {
  signsOdontogram: boolean
  procedures: number
  signedBefore: boolean
}): boolean {
  return input.signsOdontogram || (input.procedures > 0 && input.signedBefore)
}

/** «sus alergias, sus enfermedades y su medicación»: lo que se le pregunta (la ASA no se pregunta, se clasifica). */
export function healthGapWords(gaps: readonly HealthGap[]): string {
  return listWords(gaps.flatMap((gap) => (gap === "asa" ? [] : [HEALTH_GAP_WORDS[gap]])))
}

/**
 * Una ficha a medias de la atención, como la ve quien firma (revisión final del
 * 15 nov, propuesta 4): la ficha se cierra con la firma, sin un «Finalizar»
 * propio mientras la atención está en curso.
 */
export interface SignForm {
  id: string
  title: string
  /** Las preguntas con respuesta, contando las de Clío marcadas para entrar con la firma. */
  answered: number
  /** Las respuestas de Clío marcadas para entrar con la firma. */
  clio: number
  /** Las obligatorias que siguen vacías: sin ellas la ficha no se finaliza y queda a medias. */
  missing: string[]
}

/** Lo que ve quien firma de cada ficha a medias: lo respondido con lo que entra de Clío, y lo que falta. */
export function signFormsOf(
  open: ReadonlyArray<{ id: string; title: string }>,
  forms: ReadonlyArray<Pick<FormResponse, "id" | "answers" | "templateSnapshot">>,
  marked: ReadonlyArray<Pick<DictationSuggestion, "kind" | "payload">>,
): SignForm[] {
  return open.map((item) => {
    const form = forms.find((candidate) => candidate.id === item.id)
    const clio = marked.filter((suggestion) => suggestion.kind === "ficha" && suggestion.payload["responseId"] === item.id)
    const answers: Record<string, unknown> = { ...(form?.answers ?? {}) }
    for (const suggestion of clio) answers[String(suggestion.payload["fieldId"])] = suggestion.payload["value"]
    return {
      id: item.id,
      title: item.title,
      answered: Object.values(answers).filter((value) => !isEmptyAnswer(value)).length,
      clio: clio.length,
      missing: form ? missingRequired(form.templateSnapshot, answers).map((field) => field.label) : [],
    }
  })
}

/** Viene marcada para finalizarse con la firma si tiene al menos una respuesta y ninguna obligatoria vacía. */
export const finishesByDefault = (form: SignForm): boolean => form.answered > 0 && form.missing.length === 0

/** Las que se finalizan con la firma: las marcadas por omisión, salvo las que quien firma tocó. */
export function finishingAtSign(forms: readonly SignForm[], toggled: readonly string[]): string[] {
  return forms.filter((form) => form.missing.length === 0 && isOn(finishesByDefault(form), toggled, form.id)).map((form) => form.id)
}

/** «3 respuestas, 1 de Clío», «Sin respuestas», y lo que falta para finalizarla. */
export function signFormWords(form: SignForm): string {
  const answers =
    form.answered === 0
      ? "Sin respuestas"
      : `${answersWords(form.answered)}${form.clio > 0 ? `, ${form.clio} de ${CLINICAL_NAME}` : ""}`
  return form.missing.length > 0 ? `${answers} · falta ${listWords(form.missing.map((label) => `«${label}»`))}: queda a medias` : answers
}

/**
 * Las fichas de la atención en la firma, un bloque por ficha: lo que tiene, lo
 * que propone Clío para ella (`proposals`) y «Finalizarla al firmar», marcada
 * si tiene respuestas. Nada frena la firma: la que queda a medias se termina
 * después, aquí mismo. `id`: el diálogo lo anuncia al abrirse.
 */
export function FormsAtSign({
  forms,
  finishing,
  onFinishToggle,
  onComplete,
  proposals,
  disabled = false,
  id,
}: {
  forms: readonly SignForm[]
  finishing: readonly string[]
  onFinishToggle?: (formId: string, finish: boolean) => void
  /** «Completar ahora»: cierra el cierre y abre esa ficha. */
  onComplete?: (formId: string) => void
  /** Lo que propone Clío para cada ficha, con sus casillas. */
  proposals?: (formId: string) => React.ReactNode
  disabled?: boolean
  id?: string
}): React.JSX.Element | null {
  const titleId = useId()
  if (forms.length === 0) return null
  return (
    <section id={id} aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="font-medium">
        {forms.length === 1 ? "La ficha de esta atención" : "Las fichas de esta atención"}
      </h3>
      <ul className="flex flex-col gap-2">
        {forms.map((form) => {
          const checked = finishing.includes(form.id)
          return (
            <li key={form.id} className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium [overflow-wrap:anywhere]">{form.title}</span>
                  <span className="text-xs text-muted-foreground">{signFormWords(form)}</span>
                </span>
                {onComplete ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11 sm:min-h-8"
                    disabled={disabled}
                    aria-label={`Completar ahora ${form.title}`}
                    onClick={() => onComplete(form.id)}
                  >
                    Completar ahora
                  </Button>
                ) : null}
              </div>
              {proposals?.(form.id)}
              {onFinishToggle ? (
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={checked}
                    disabled={disabled || form.missing.length > 0}
                    aria-label={forms.length === 1 ? "Finalizarla al firmar" : `Finalizar «${form.title}» al firmar`}
                    onCheckedChange={(value) => onFinishToggle(form.id, value === true)}
                  />
                  Finalizarla al firmar
                </label>
              ) : null}
              {!checked ? (
                <span className="text-xs text-muted-foreground">
                  Queda a medias: la terminas después, aquí mismo en la atención, con su propia fecha y hora.
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function EncounterClosingDialog({
  open,
  form,
  signAs,
  who,
  consents,
  closing = null,
  materials = null,
  missing = [],
  onRegister,
  onOpenBlock,
  startedAt,
  pending,
  canSign,
  blockedReason,
  onSignNow,
  onPaper,
  onClose,
  signatureHint = null,
  registration = null,
  confirmLabel = null,
  initialFocus,
  sessionLabel = (session) => session.title,
  sessionAnswers = {},
  onSessionAnswer,
  keepDiagnoses,
  onKeepDiagnosis,
  children,
  nextVisit = null,
  mayCharge = true,
  safety = null,
  onCompleteForm,
  signForms = [],
  finishingForms,
  onFinishFormToggle,
  formProposals,
  dictated = null,
}: {
  open: boolean
  form: ClosingForm
  /** «Ana Torres · Cirujano dentista · COP 12345», de su perfil. */
  signAs: string | null
  /** Primer nombre de quien firma el consentimiento. */
  who: string
  consents: ConsentNeed[]
  /** Lo que el servidor dice del cierre: el producto muestra lo suyo (odentIA: odontograma y periodontograma). */
  closing?: ClosingCheck | null
  /**
   * Los materiales que se descontarán de la sede al firmar (ADR 0067). Solo
   * informa: no pide confirmar ni bloquea si no alcanzan.
   */
  materials?: ClosingMaterials | null
  /** Lo que falta registrar para cerrar (si el servidor lo rechazó por eso), sin la colegiatura. */
  missing?: ClosingRequirement[]
  /** «Registrar»: vuelve a la atención con el bloque de ese requisito abierto y el campo marcado. */
  onRegister: (requirement: ClosingRequirement) => void
  /** Vuelve a la atención con un bloque abierto (odentIA: «Seguir midiendo» el periodontograma). */
  onOpenBlock: (key: string) => void
  startedAt: string | null | undefined
  pending: boolean
  canSign: boolean
  /** Por qué aún no se puede firmar (sin guardar, sin conexión…). */
  blockedReason: string | null
  onSignNow: (need: ConsentNeed) => void
  /** «Firmado en papel»: sube la foto de la hoja firmada (la constancia lleva la hoja). */
  onPaper?: (need: ConsentNeed) => void
  onClose: () => void
  /** Su firma dibujada: si la tiene y cómo agregarla o cambiarla. */
  signatureHint?: React.ReactNode
  /** Sin colegiatura en el perfil: se pide aquí, en lugar de «Firmarás como». */
  registration?: React.ReactNode
  /** «Guardar y firmar» cuando antes hay que guardar la colegiatura. */
  confirmLabel?: string | null
  /** Dónde empieza el foco al abrir (el número de colegiatura, si se pide). */
  initialFocus?: React.RefObject<HTMLElement | null>
  /** Cómo se nombra un tratamiento de hoy («Endodoncia · 46»). */
  sessionLabel?: (session: ClosingSession) => string
  /** Lo respondido a «¿Terminaste?»; sin `onSessionAnswer` solo se informa. */
  sessionAnswers?: SessionAnswers
  onSessionAnswer?: (planItemId: string, answer: "terminar" | "otra") => void
  /** Los diagnósticos que resuelve lo de hoy y quien firma desmarcó. */
  keepDiagnoses?: ReadonlySet<string>
  onKeepDiagnosis?: (diagnosisIds: string[], keep: boolean) => void
  /** Lo que se suma al cierre (el aviso del dictado, por ejemplo). */
  children?: React.ReactNode
  /** «¿Cuándo vuelve?», con lo que se decide, después de «¿Terminaste?». */
  nextVisit?: React.ReactNode
  /**
   * Si algo de hoy puede cargarse a su cuenta al firmar (un procedimiento con precio o de su
   * plan). Sin eso, el cierre no promete «lo que se cargó hoy» (entrega 11).
   */
  mayCharge?: boolean
  /**
   * Lo que avisa la seguridad del paciente antes de firmar, sin frenar (QA del 16 nov): la presión
   * alta y la línea de anestesia (ASA y máximo por peso), las mismas de la atención.
   */
  safety?: React.ReactNode
  /** «Completar ahora» del formulario a medias: cierra el cierre y lo abre. */
  onCompleteForm?: (formId: string) => void
  /** Las fichas a medias de la atención, un bloque por ficha (`signFormsOf`). */
  signForms?: readonly SignForm[]
  /** Las que se finalizan con la firma («Finalizarla al firmar»). */
  finishingForms?: readonly string[]
  onFinishFormToggle?: (formId: string, finish: boolean) => void
  /** Lo que propone Clío para cada ficha, dentro de su bloque. */
  formProposals?: (formId: string) => React.ReactNode
  /** Lo dictado sin confirmar, marcado para entrar con la firma: el mismo cierre, sin otro diálogo. */
  dictated?: React.ReactNode
}): React.JSX.Element {
  const ids = useId()
  // Riesgos propios escritos sin guardar: firmar los guarda antes de abrir la hoja (QA de diseño del 18 nov, H1).
  const risksDrafts = useRisksDrafts()
  // Quien no ve la caja no recibe lo que debe en «Atención finalizada»: no se le promete (QA antes de entregar).
  const seesFinance = usePermission("finance.read")
  const ProductClosing = productUi().encounter.Closing
  const bounds = endTimeBounds(startedAt)
  const needsReason = consents.length > 0
  const onSubmit = useFormSubmit(form, { fieldMap: CLOSING_FIELD_MAP })
  // La consulta marcada también se carga: «No se carga nada» ya no sería cierto.
  const consultationChoice = useStore(form.store, (state) => state.values.consultation ?? "")
  const charges = mayCharge || (Boolean(closing?.consultation) && consultationChoice !== "none")
  const formError = useFormSubmitError(form)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const busy = pending || submitting
  const toRegister = missing.filter((requirement) => requirement !== "signature")
  // «Hora de fin» se decide: va con lo que se decide, antes de lo que solo se lee (QA del 16 nov, Q18).
  const endTime = (
    <form.AppField name="endTime">
      {(field) => (
        <field.Control label="Hora de fin">
          {(control) => (
            <TimeSelect
              id={control.id}
              invalid={control.invalid}
              aria-describedby={control.describedBy}
              className="w-44"
              min={bounds.min}
              max={bounds.max}
              emptyLabel={bounds.past ? "La de su cita" : `Ahora (${bounds.max})`}
              value={field.state.value}
              onChange={(value) => {
                field.handleChange(value)
                field.handleBlur()
              }}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose()
      }}
    >
      {/* Lo de en medio se desplaza; el título y «Finalizar y firmar» quedan siempre a la vista, también en un teléfono. */}
      {/* El aviso del formulario a medias también describe el diálogo: el lector lo dice al abrirlo. */}
      <DialogContent
        aria-describedby={signForms.length > 0 ? `${ids}-desc ${ids}-forms` : `${ids}-desc`}
        className="flex max-h-[90dvh] flex-col sm:max-w-lg"
        initialFocus={initialFocus}
      >
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Finalizar y firmar</DialogTitle>
            <DialogDescription id={`${ids}-desc`}>
              Después del cierre solo se agregan adendas. Si vino de una cita, la cita queda atendida.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="-mx-6 flex min-h-0 flex-1 flex-col">
            <div className="flex flex-col gap-4 px-6 text-sm">
              {/* Primero lo que se decide (P10): lo que falta, la colegiatura si no la tiene, el
                  consentimiento, «¿Terminaste?» y «¿Cuándo vuelve?»; después lo que solo se lee. */}
              {registration}
              {toRegister.length > 0 ? (
                <ul aria-label="Falta para cerrar" className="flex flex-col gap-1.5 rounded-lg border border-destructive/50 p-3">
                  {toRegister.map((requirement) => (
                    <li key={requirement} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        Falta: {CLOSING_REQUIREMENT_LABELS[requirement]}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="link"
                        className="h-auto p-0"
                        disabled={busy}
                        onClick={() => onRegister(requirement)}
                      >
                        Registrar
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* La presión y la anestesia avisan antes del consentimiento: son de lo que se decide (ADR 0197). */}
              {safety}
              {consents.map((need) => {
                const line = consentLine(need, who)
                return (
                  <div
                    key={`${need.templateKey}-${need.documentId ?? ""}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/50 p-3"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium">{line.title}</span>
                      <span className="text-xs text-muted-foreground">{line.detail}</span>
                    </div>
                    {need.status !== "sin_publicar" ? (
                      <span className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSignNow(need)}>
                          {need.personSigned
                            ? "Confirmar"
                            : hasRisksDraft(risksDrafts, {
                                  documentIds: [need.documentId],
                                  planItemIds: [need.planItemId],
                                })
                              ? "Guardar y firmar"
                              : "Firmar ahora"}
                        </Button>
                        {/* Firmado en papel: con la foto de la hoja, no una palabra (consentimientos, 10 nov). */}
                        {onPaper && need.documentId && !need.personSigned ? (
                          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onPaper(need)}>
                            Firmado en papel
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                )
              })}
              {needsReason ? <ConsentSkipReason form={form} disabled={busy} /> : null}
              {/* «¿Terminaste?» antes de lo que cambia con su respuesta (el odontograma que se firma). */}
              {closing?.sessions && onSessionAnswer ? (
                <ClosingSessions
                  sessions={closing.sessions}
                  labelOf={sessionLabel}
                  answers={sessionAnswers}
                  onAnswer={onSessionAnswer}
                  disabled={busy}
                  resolvable={closing.resolvable}
                  keepDiagnoses={keepDiagnoses}
                  onKeepDiagnosis={onKeepDiagnosis}
                  part="decide"
                />
              ) : null}
              {closing ? (
                <form.AppField name="consultation">
                  {(field) => (
                    <ClosingBilling
                      id={`${ids}-cobro`}
                      closing={closing}
                      choice={(field.state.value as string | undefined) ?? ""}
                      onChoice={(next) => field.handleChange(next)}
                      disabled={busy}
                    />
                  )}
                </form.AppField>
              ) : null}
              {nextVisit}
              {endTime}
              {/* Desde aquí, lo que solo se lee: lo que sigue en curso y lo que firma el producto (NTS 188). */}
              {closing?.sessions && onSessionAnswer ? (
                <ClosingSessions
                  sessions={closing.sessions}
                  labelOf={sessionLabel}
                  answers={sessionAnswers}
                  onAnswer={onSessionAnswer}
                  disabled={busy}
                  part="read"
                />
              ) : null}
              {closing ? <ProductClosing closing={closing} pending={busy} openBlock={onOpenBlock} /> : null}
              {materials && materials.items.length > 0 ? (
                <p className="rounded-lg border p-3">
                  <span className="font-medium">Materiales</span>
                  {" · "}
                  {closingMaterialsWords(materials, activeOrgLocale() ?? "es")}
                </p>
              ) : null}
              {dictated}
              <FormsAtSign
                id={`${ids}-forms`}
                forms={signForms}
                finishing={finishingForms ?? []}
                onComplete={onCompleteForm}
                proposals={formProposals}
                {...(onFinishFormToggle ? { onFinishToggle: onFinishFormToggle } : {})}
                disabled={busy}
              />
              {children}
              {/* Leído, no decidido: de quién es la firma (sin colegiatura, sus campos van arriba). */}
              {registration ? null : (
                <div className="rounded-lg border p-3">
                  <p className="font-medium">Firmarás como {signAs ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">De tu perfil profesional</p>
                  {signatureHint}
                </div>
              )}
              {blockedReason ? (
                <p id={`${ids}-blocked`} role="status" className="text-xs text-muted-foreground">
                  {blockedReason}
                </p>
              ) : null}
              {charges || seesFinance ? (
                <p className="text-xs text-muted-foreground">
                  {!charges
                    ? // Hoy no se carga nada: solo lo que ya debía (QA de la ficha del 10 nov, B6).
                      "No se carga nada. Después: si debe algo de antes, para avisar a caja."
                    : seesFinance
                      ? "Después: lo que se cargó hoy a su cuenta y lo que debe, para avisar a caja."
                      : "Después: lo que se cargó hoy a su cuenta, para avisar a caja."}
                </p>
              ) : null}
            </div>
          </ScrollArea>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Volver
            </Button>
            <Button
              type="submit"
              disabled={!canSign || busy}
              aria-describedby={blockedReason ? `${ids}-blocked` : undefined}
            >
              {busy ? "Firmando…" : (confirmLabel ?? productUi().encounter.signLabel(closing) ?? "Finalizar y firmar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** El bloque de la colegiatura vive aparte: también lo usa el consentimiento en la tablet. */
export { SignatureRegistrationFields } from "./signature-registration-fields"

const CONSULTATION_REASON: Record<string, string> = {
  cita: "Era el servicio de su cita.",
  "mas-cobrada": "La consulta que más cobra la clínica.",
  biblioteca: "La consulta de la lista de servicios.",
}

/**
 * Lo que se firma como hecho hoy, con su pieza y lo que se cargará, y la consulta ya marcada si
 * hoy no se hizo nada (mesa del cierre de la atención, 19 nov 2026). Antes decía «2
 * procedimientos» sin nombrarlos ni el total, y una consulta sin nada hecho no se cobraba.
 */
function ClosingBilling({
  id,
  closing,
  choice,
  onChoice,
  disabled,
}: {
  id: string
  closing: ClosingCheck
  /** Vacío: la marcada; «none»: desmarcada; si no, el servicio elegido con «Cambiar». */
  choice: string
  onChoice: (next: string) => void
  disabled: boolean
}): React.JSX.Element | null {
  const [changing, setChanging] = useState(false)
  const locale = activeOrgLocale() ?? "es-PE"
  const lines = closing.billing?.lines ?? []
  const consultation = closing.consultation ?? null
  if (lines.length === 0 && !consultation) return null
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale)
  const chosen = consultation
    ? choice === "none"
      ? null
      : (consultation.options.find((option) => option.serviceId === choice) ?? consultation.proposed)
    : null
  // El total: lo de hoy más la consulta marcada, por moneda.
  const totals = new Map<string, number>()
  for (const total of closing.billing?.totals ?? []) totals.set(total.currency, total.totalCents)
  if (chosen) totals.set(chosen.currency, (totals.get(chosen.currency) ?? 0) + chosen.priceCents)
  const totalWords = [...totals.entries()].map(([currency, cents]) => money(cents, currency)).join(" y ")
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      {lines.length > 0 ? (
        <>
          <p className="font-medium">Lo que firmas como hecho hoy</p>
          <ul className="flex flex-col gap-1" aria-label="Lo que firmas como hecho hoy">
            {lines.map((line) => (
              <li key={line.procedureId} className="flex items-baseline justify-between gap-3">
                <span>{[line.description, line.site].filter(Boolean).join(" · ")}</span>
                <span className={line.amountCents != null ? "font-medium" : "text-xs text-muted-foreground"}>
                  {line.amountCents != null && line.currency
                    ? money(line.amountCents, line.currency)
                    : line.reason === "covered"
                      ? "ya cargado"
                      : "sin cargo"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Si algo no lo hiciste, vuelve y anúlalo en su fila («Anular…») antes de firmar.</p>
        </>
      ) : null}
      {consultation ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium">Lo que se cobra hoy</p>
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${id}-consulta`}
              checked={chosen !== null}
              disabled={disabled}
              onCheckedChange={(checked) => onChoice(checked === true ? "" : "none")}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <label htmlFor={`${id}-consulta`} className="font-medium">
                {(chosen ?? consultation.proposed).name} · {money((chosen ?? consultation.proposed).priceCents, (chosen ?? consultation.proposed).currency)}
              </label>
              <span className="text-xs text-muted-foreground">
                {chosen === null
                  ? "Desmarcada: hoy no se cobra."
                  : `${chosen.serviceId !== consultation.proposed.serviceId ? "La elegiste con «Cambiar»." : CONSULTATION_REASON[consultation.proposed.reason]} Desmárcala si hoy no se cobra.`}
              </span>
            </div>
            {consultation.options.length > 1 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-expanded={changing}
                aria-label="Cambiar la consulta"
                onClick={() => setChanging((open) => !open)}
              >
                Cambiar
              </Button>
            ) : null}
          </div>
          {changing ? (
            <ToggleGroup
              aria-label="Consultas de la clínica"
              value={chosen ? [chosen.serviceId] : []}
              onValueChange={(next: unknown[]) => {
                const picked = next[0]
                if (typeof picked !== "string") return
                onChoice(picked)
                setChanging(false)
              }}
              disabled={disabled}
              spacing={2}
              className="w-full min-w-0 flex-wrap"
            >
              {consultation.options.map((option) => (
                <ToggleGroupItem key={option.serviceId} value={option.serviceId} className={`${CHIP} h-auto min-w-0 max-w-full whitespace-normal break-words text-left`}>
                  {chosen?.serviceId === option.serviceId ? <Check aria-hidden className="size-4" /> : null}
                  {option.name} · {money(option.priceCents, option.currency)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
        </div>
      ) : null}
      <p className="text-sm">
        {totals.size > 0 ? `Se cargará ${totalWords} a su cuenta, para avisar a caja.` : "No se carga nada de hoy."}
      </p>
    </div>
  )
}
