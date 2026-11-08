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
  Input,
  ScrollArea,
} from "@odentia/ui"
import { sessionWords, showsSession } from "@odentia/clinical"
import { DatePickerButton, TimeSelect, useAppForm, useFormSubmit, useFormSubmitError, zonedDateOf } from "@odentia/ui-patterns"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { useStore } from "@tanstack/react-form"
import { Check } from "lucide-react"
import { useId, useRef } from "react"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
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
  type ClosingSession,
  controlDaySaid,
  type HealthGap,
  type NextSession,
  type SignatureRegistration,
  signatureRegistrationErrors,
} from "../../lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { closingMaterialsWords } from "../../lib/materials"
import { productUi } from "../../product/product-ui"
import { whenSaid } from "../agenda/shared"

/**
 * Entre qué horas puede haber terminado la atención, en la zona de la clínica:
 * desde su inicio (una de otro día, desde las 00:00) hasta ahora. La lista
 * («Hora», cada 15 minutos) va dentro de esos límites.
 */
export function endTimeBounds(
  startedAt: string | null | undefined,
  now = new Date(),
): { min: string; max: string } {
  const nowValue = clinicDateTimeValue(now.toISOString())
  const max = nowValue.slice(11, 16)
  let min = "00:00"
  if (startedAt) {
    const startValue = clinicDateTimeValue(startedAt)
    if (startValue.slice(0, 10) === nowValue.slice(0, 10)) min = startValue.slice(11, 16)
  }
  return { min, max }
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
}

/** Los datos de `/finalize` que la pantalla llama de otro modo. */
export const CLOSING_FIELD_MAP = { endedAt: "endTime", "nextControl.dueAt": "nextControlDate" } as const

const EMPTY_CLOSING: ClosingValues = {
  endTime: "",
  consentSkipReason: "",
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
  nextControl: "",
  nextControlDate: "",
  fulfill: {},
}

/** Un control de Clío marcado para entrar con la firma: ya dice cuándo vuelve. */
export interface DictatedControl {
  id: string
  /** Su día (`yyyy-MM-dd`) en la zona de la clínica. */
  day: string
}

/**
 * El control por cumplir queda cumplido con esta visita: lo marcado, o lo que
 * viene marcado si nadie lo tocó (solo el que indicó quien firma).
 */
export function fulfills(value: Pick<ClosingValues, "fulfill">, control: ClosingDueControl): boolean {
  return value.fulfill[control.id] ?? control.mine
}

/** Lo que ya dice cuándo vuelve, sin preguntar: así no quedan dos controles. */
type KnownReturn =
  | { kind: "dictated"; id: string; day: string }
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
  value: Pick<ClosingValues, "fulfill">,
  controls: ClosingControls,
  dictated: DictatedControl | null,
): KnownReturn | null {
  if (dictated) return { kind: "dictated", ...dictated }
  const repeating =
    controls.due.find((control) => fulfills(value, control) && control.repeatEveryMonths) ??
    controls.byAppointment.find((control) => control.repeatEveryMonths)
  if (repeating?.repeatEveryMonths) return { kind: "repeats", months: repeating.repeatEveryMonths }
  if (controls.next) return { kind: "control", control: controls.next }
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
}

/**
 * Lo que sigue en curso si se firma con lo respondido (la regla del servidor,
 * `applySessionAnswers`): mientras algo sigue, «¿Cuándo vuelve?» es su próxima
 * sesión y no pregunta por un control (QA del 8 nov, X11).
 */
export function continuingAfterSign(
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[] } | null | undefined,
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
  return [
    ...sessions.continuing.map((session) => visit(session, session.m)),
    ...sessions.finishing
      .filter((session) => answers[session.planItemId] === "otra")
      .map((session) => visit(session, Math.max(session.m, session.n) + 1)),
  ]
}

/** «el lun 9 a las 10:45», «mañana a las 17:00», en la zona de la clínica. */
export function visitWhenSaid(iso: string): string {
  const timeZone = activeOrgTimeZone()
  return whenSaid(iso, timeZone, zonedDateOf(new Date().toISOString(), timeZone))
}

/** «Endodoncia · 46 · sesión 2 de 2»; uno de una sola sesión, solo su nombre. */
export function sessionLine(label: string, n: number, m: number): string {
  return showsSession(n, m) ? `${label} · ${sessionWords(n, m)}` : label
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
): { followUpIds?: string[]; nextControl?: { dueAt: string } | { none: true } } {
  if (!controls) return {}
  const followUpIds = controls.due.filter((control) => fulfills(value, control)).map((control) => control.id)
  if ((continuing && !value.askControl) || knownReturn(value, controls, dictated)) return { followUpIds }
  if (value.nextControl === "none") return { followUpIds, nextControl: { none: true } }
  const day = chosenDay(value, controls)
  return day ? { followUpIds, nextControl: { dueAt: day } } : { followUpIds }
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
}): React.JSX.Element | null {
  const ids = useId()
  const values = useStore(form.store, (state) => state.values)
  if (!controls) return null
  const known = knownReturn(values, controls, dictated)
  const sessionsLines = continuing.map((visit) => {
    if (visit.booked)
      return `Vuelve ${visitWhenSaid(visit.booked.startsAt)} para ${sessionLine(visit.label, visit.booked.n, visit.booked.m)}, con su cita.`
    const line = sessionLine(visit.label, visit.n, visit.m)
    return canBook
      ? `Vuelve para ${line}: al firmar puedes reservar su cita aquí mismo.`
      : `Vuelve para ${line}: recepción la verá en «Qué sigue» para reservarla.`
  })
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
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
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
            Por qué: cualquier atención desde unos días antes de su fecha le sirve. Viene marcado si lo indicaste tú.
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
        {sessionsLines.length > 0 && !known && !values.askControl ? (
          <p className="text-xs text-muted-foreground">
            El control se indica en la sesión en que termine.{" "}
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
              ? `Vuelve el ${controlDaySaid(known.day)}, como dictaste.`
              : known.kind === "repeats"
                ? `Su control se repite: el siguiente queda para ${recallWords(known.months)}.`
                : known.kind === "stays"
                  ? `Sigue pendiente su ${inSentence(known.control.title)} del ${controlDaySaid(dayOf(known.control.dueAt))}: recepción lo verá.`
                  : known.control.scheduledAt
                    ? `Vuelve el ${controlDaySaid(dayOf(known.control.scheduledAt))}, con su cita.`
                    : `Vuelve el ${controlDaySaid(dayOf(known.control.dueAt))} · Para cambiarlo, en Plan y controles.`}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <ToggleGroup
                aria-labelledby={`${ids}-cuando`}
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
              {day
                ? `Vuelve hacia el ${controlDaySaid(day)} · recepción lo verá para reservarlo`
                : none
                  ? "Queda dicho que no hace falta otro control."
                  : values.nextControl === "date"
                    ? "Elige el día en el calendario."
                    : "No indicaste cuándo vuelve: recepción no lo verá"}
            </p>
          </>
        )}
      </div>
    </div>
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
  /** El perfil no tiene colegiatura: se pide aquí. */
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
        if (latest.current.needsRegistration) Object.assign(fields, signatureRegistrationErrors(value))
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
 * Lo que se respondió a «¿Terminaste?» de cada tratamiento. Sin respuesta vale
 * «Sí, terminar»: es lo que viene elegido y lo que hace el servidor (ADR 0161).
 */
export type SessionAnswers = Record<string, "terminar" | "otra">

/**
 * Lo trabajado hoy de un tratamiento, una línea por cada uno. Lo que con esta
 * atención llega a sus sesiones previstas pregunta «¿Terminaste?» con «Sí,
 * terminar» ya elegido y «Falta otra sesión» a un toque, y dice debajo qué
 * pasará al firmar; lo demás dice que sigue en curso. El mismo bloque va en el
 * cierre y al firmar con lo dictado.
 */
export function ClosingSessions({
  sessions,
  labelOf,
  answers,
  onAnswer,
  disabled,
}: {
  sessions: { finishing: ClosingSession[]; continuing: ClosingSession[]; notRegistered?: ClosingSession[] }
  labelOf: (session: ClosingSession) => string
  answers: SessionAnswers
  onAnswer: (planItemId: string, answer: "terminar" | "otra") => void
  disabled: boolean
}): React.JSX.Element | null {
  const ids = useId()
  const notRegistered = sessions.notRegistered ?? []
  if (sessions.finishing.length === 0 && sessions.continuing.length === 0 && notRegistered.length === 0) return null
  // Una resina de una sesión no dice «sesión 1 de 1»: solo su nombre.
  const line = (session: ClosingSession) =>
    showsSession(session.n, session.m) ? `${labelOf(session)} · ${sessionWords(session.n, session.m)}` : labelOf(session)
  const choices = [
    { value: "terminar", label: "Sí, terminar" },
    { value: "otra", label: "Falta otra sesión" },
  ] as const
  return (
    <ul aria-label="Tratamientos de hoy" className="flex flex-col gap-2 rounded-lg border p-3">
      {sessions.finishing.map((session, index) => {
        const answer = answers[session.planItemId] ?? "terminar"
        const labelId = `${ids}-terminaste-${index}`
        return (
          <li key={session.planItemId} className="flex flex-col gap-2">
            <span id={labelId}>
              <span className="font-medium">{line(session)}</span> · ¿Terminaste?
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
          </li>
        )
      })}
      {sessions.continuing.map((session) => (
        <li key={session.planItemId} className="text-muted-foreground">
          {/* Si sus sesiones habituales eran más de las que hizo falta, terminarlo es un toque. */}
          Sigue en curso: {line(session)}. Si ya terminaste, «Completar» en «Hecho hoy».
        </li>
      ))}
      {/* Avisa, no frena: quizá hoy no se pudo hacer. */}
      {notRegistered.map((session) => (
        <li key={session.planItemId} className="text-muted-foreground">
          La cita traía {line(session)} y no registraste su sesión: si la hiciste, regístrala en «Hecho hoy».
        </li>
      ))}
    </ul>
  )
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
}: {
  sessions: NextSession[]
  /** «Endodoncia · 46». */
  labelOf: (session: NextSession) => string
  /** Recibe el foco al reservar: el botón que abrió la reserva ya no está. */
  listRef?: React.Ref<HTMLUListElement>
  canBook: boolean
  onBook: (planItemIds: string[]) => void
}): React.JSX.Element | null {
  if (sessions.length === 0) return null
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
                Vuelve {visitWhenSaid(session.booked.startsAt)} para{" "}
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
          {only && showsSession(only.n, only.m) ? `Reservar la sesión ${only.n}` : "Reservar su próxima cita"}
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

/** «sus alergias, sus enfermedades y su medicación»: lo que se le pregunta (la ASA no se pregunta, se clasifica). */
export function healthGapWords(gaps: readonly HealthGap[]): string {
  return listWords(gaps.flatMap((gap) => (gap === "asa" ? [] : [HEALTH_GAP_WORDS[gap]])))
}

/**
 * Con anestesia y algo por saber de su salud, el cierre lo dice junto a los
 * materiales (QA del 8 nov, A2): avisa y deja firmar; la firma guarda lo que
 * faltaba. Sin anestesia, lo que falta va en «Sin registrar».
 */
export function AnesthesiaHealthLine({
  anesthetics,
  gaps,
  onComplete,
  disabled = false,
}: {
  anesthetics: readonly string[]
  gaps: readonly HealthGap[]
  /** «Completar en Antecedentes»: los abre encima de la atención. */
  onComplete?: () => void
  disabled?: boolean
}): React.JSX.Element | null {
  if (anesthetics.length === 0 || gaps.length === 0) return null
  const asked = healthGapWords(gaps)
  const missing = [asked ? `preguntarle por ${asked}` : "", gaps.includes("asa") ? "clasificar su riesgo anestésico (ASA)" : ""]
    .filter(Boolean)
    .join("; ")
  return (
    <div role="note" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/50 bg-warning-soft p-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">Anestesia con su salud por completar</span>
        <span className="text-xs text-muted-foreground">
          Se usa {listWords(anesthetics)}. Falta {missing}. Puedes firmar igual: queda anotado lo que faltaba.
        </span>
      </div>
      {onComplete ? (
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onComplete}>
          Completar en Antecedentes
        </Button>
      ) : null}
    </div>
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
  onClose,
  signatureHint = null,
  registration = null,
  confirmLabel = null,
  initialFocus,
  sessionLabel = (session) => session.title,
  sessionAnswers = {},
  onSessionAnswer,
  children,
  nextVisit = null,
  healthGaps = [],
  onCompleteHealth,
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
  /** Lo que se suma al cierre (el aviso del dictado, por ejemplo). */
  children?: React.ReactNode
  /** «¿Cuándo vuelve?», justo encima de firmar. */
  nextVisit?: React.ReactNode
  /** Lo que falta saber de su salud, como lo dice el servidor (odentIA también cuenta la ASA). */
  healthGaps?: HealthGap[]
  /** «Completar en Antecedentes» desde la línea de anestesia. */
  onCompleteHealth?: () => void
}): React.JSX.Element {
  const ids = useId()
  const ProductClosing = productUi().encounter.Closing
  const bounds = endTimeBounds(startedAt)
  const needsReason = consents.length > 0
  const onSubmit = useFormSubmit(form, { fieldMap: CLOSING_FIELD_MAP })
  const formError = useFormSubmitError(form)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const busy = pending || submitting
  const toRegister = missing.filter((requirement) => requirement !== "signature")
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose()
      }}
    >
      {/* Lo de en medio se desplaza; el título y «Finalizar y firmar» quedan siempre a la vista, también en un teléfono. */}
      <DialogContent aria-describedby={`${ids}-desc`} className="flex max-h-[90dvh] flex-col sm:max-w-lg" initialFocus={initialFocus}>
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Finalizar y firmar</DialogTitle>
            <DialogDescription id={`${ids}-desc`}>
              Después del cierre solo se agregan adendas. Si vino de una cita, la cita queda atendida.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="-mx-6 flex min-h-0 flex-1 flex-col">
            <div className="flex flex-col gap-4 px-6 text-sm">
              {registration ?? (
                <div className="rounded-lg border p-3">
                  <p className="font-medium">Firmarás como {signAs ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">De tu perfil profesional</p>
                  {signatureHint}
                </div>
              )}
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
              {/* «¿Terminaste?» antes de lo que cambia con su respuesta (el odontograma que se firma). */}
              {closing?.sessions && onSessionAnswer ? (
                <ClosingSessions
                  sessions={closing.sessions}
                  labelOf={sessionLabel}
                  answers={sessionAnswers}
                  onAnswer={onSessionAnswer}
                  disabled={busy}
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
              <AnesthesiaHealthLine
                anesthetics={closing?.health?.anesthetics ?? []}
                gaps={healthGaps}
                onComplete={onCompleteHealth}
                disabled={busy}
              />
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
                      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSignNow(need)}>
                        {need.personSigned ? "Confirmar" : "Firmar ahora"}
                      </Button>
                    ) : null}
                  </div>
                )
              })}
              {needsReason ? (
                <form.AppField name="consentSkipReason">
                  {(field) => (
                    <field.TextareaField
                      label="Seguir sin él: ¿por qué?"
                      rows={2}
                      maxLength={2000}
                      required
                      placeholder="Ej.: urgencia, se firmará en la próxima visita"
                    />
                  )}
                </form.AppField>
              ) : null}
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
                        emptyLabel={`Ahora (${bounds.max})`}
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
              {children}
              {blockedReason ? (
                <p id={`${ids}-blocked`} role="status" className="text-xs text-muted-foreground">
                  {blockedReason}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Después: lo que quedó por cobrar, para avisar a caja.
              </p>
              {nextVisit}
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

/**
 * Sin colegiatura no se firma (ADR 0003: nombre y colegiatura en cada
 * atención): se pide en el mismo cierre, sin salir de la atención, y se
 * guarda en el perfil profesional para las siguientes. El título solo se pide
 * si el perfil no lo tiene; el colegio viene propuesto por el país del
 * producto (COP en odentIA, CMP en latidIA) y se puede cambiar. Cada falta se
 * dice en su campo.
 */
export function SignatureRegistrationFields({
  form,
  signAs,
  askTitle,
  disabled,
  numberRef,
}: {
  form: ClosingForm
  /** El nombre con que firma, de su cuenta o su perfil. */
  signAs: string | null
  askTitle: boolean
  disabled: boolean
  /** El número es lo que falta escribir: ahí empieza el foco. */
  numberRef?: React.Ref<HTMLInputElement>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning-soft p-3">
      <div className="flex flex-col">
        <p className="font-medium">Falta tu colegiatura para firmar</p>
        <p className="text-xs text-muted-foreground">
          {signAs ? `Firmarás como ${signAs}. ` : ""}La historia clínica pide nombre y colegiatura.
        </p>
      </div>
      {askTitle ? (
        <form.AppField name="professionalTitle">
          {(field) => <field.TextField label="Título profesional" maxLength={120} disabled={disabled} />}
        </form.AppField>
      ) : null}
      <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-3">
        <form.AppField name="registrationBody">
          {(field) => <field.TextField label="Colegio" maxLength={40} disabled={disabled} />}
        </form.AppField>
        <form.AppField name="registrationNumber">
          {(field) => (
            <field.Control
              label="Número de colegiatura"
              description="Se guarda en tu perfil profesional: no la volverá a pedir."
            >
              {(control) => (
                <Input
                  {...control.props}
                  ref={numberRef}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={20}
                  disabled={disabled}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </div>
  )
}
