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
} from "@odentia/ui"
import { DatePickerButton, TimeSelect, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useId, useRef } from "react"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
import type { ConsentNeed } from "../../lib/encounter-documents"
import {
  CLOSING_REQUIREMENT_LABELS,
  type ClosingCheck,
  type ClosingControls,
  type ClosingDueControl,
  type ClosingMaterials,
  type ClosingNextControl,
  type ClosingRequirement,
  type SignatureRegistration,
  signatureRegistrationErrors,
} from "../../lib/encounters"
import { activeOrgLocale } from "../../lib/locale"
import { ChoiceButtons } from "../choice-buttons"
import { closingMaterialsWords } from "../../lib/materials"
import { productUi } from "../../product/product-ui"

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
  /** «Cambiar» sobre el control que ya tiene: vuelven los atajos. */
  nextControlChange: boolean
  /** Lo que se cambió de lo que viene marcado en «Cumple su control…», por control. */
  fulfill: Record<string, boolean>
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
  nextControlChange: false,
  fulfill: {},
}

/** Un control de Clío marcado para entrar con la firma: ya dice cuándo vuelve. */
export interface DictatedControl {
  id: string
  /** Su día (`yyyy-MM-dd`) en la zona de la clínica. */
  day: string
}

/** El control por cumplir queda cumplido con esta visita: lo marcado, o lo que viene marcado si nadie lo tocó. */
export function fulfills(value: Pick<ClosingValues, "fulfill">, control: ClosingDueControl): boolean {
  return value.fulfill[control.id] ?? control.mine
}

/** Lo que ya dice cuándo vuelve, sin preguntar: así no quedan dos controles. */
type KnownReturn =
  | { kind: "dictated"; id: string; day: string }
  | { kind: "repeats"; months: number }
  | { kind: "control"; control: ClosingNextControl }
  | { kind: "stays"; control: ClosingDueControl }

function knownReturn(
  value: Pick<ClosingValues, "fulfill">,
  controls: ClosingControls,
  dictated: DictatedControl | null,
): KnownReturn | null {
  if (dictated) return { kind: "dictated", ...dictated }
  const repeating = controls.due.find((control) => fulfills(value, control) && control.repeatEveryMonths)
  if (repeating?.repeatEveryMonths) return { kind: "repeats", months: repeating.repeatEveryMonths }
  if (controls.next) return { kind: "control", control: controls.next }
  const stays = controls.due.find((control) => !fulfills(value, control))
  return stays ? { kind: "stays", control: stays } : null
}

/** Se pregunta «¿Cuándo vuelve?»: no tiene otro control, o pidió «Cambiar» el que tiene. */
function asksNextControl(
  value: Pick<ClosingValues, "fulfill" | "nextControlChange">,
  known: KnownReturn | null,
): boolean {
  return !known || (known.kind === "control" && known.control.status === "pendiente" && value.nextControlChange)
}

/** Falta el día de «Otra fecha»: lo dice su campo. */
export function needsNextControlDay(
  value: ClosingValues,
  controls: ClosingControls | null,
  dictated: DictatedControl | null,
): boolean {
  if (!controls || value.nextControl !== "date" || value.nextControlDate) return false
  return asksNextControl(value, knownReturn(value, controls, dictated))
}

/**
 * Lo que el cierre manda de los controles: cuáles cumple esta visita y, si se
 * preguntó, cuándo vuelve (con «Cambiar», el día nuevo del control que ya tiene).
 */
export function closingControlsBody(
  value: ClosingValues,
  controls: ClosingControls | null,
  dictated: DictatedControl | null,
): { followUpIds?: string[]; nextControl?: { dueAt: string; followUpId?: string } | { none: true } } {
  if (!controls) return {}
  const followUpIds = controls.due.filter((control) => fulfills(value, control)).map((control) => control.id)
  const known = knownReturn(value, controls, dictated)
  if (!asksNextControl(value, known)) return { followUpIds }
  if (value.nextControl === "none" && !known) return { followUpIds, nextControl: { none: true } }
  const day =
    value.nextControl === "date"
      ? value.nextControlDate
      : value.nextControl === "week" || value.nextControl === "month" || value.nextControl === "recall"
        ? controls.shortcuts[value.nextControl]
        : ""
  if (!day) return { followUpIds }
  return { followUpIds, nextControl: { dueAt: day, ...(known?.kind === "control" ? { followUpId: known.control.id } : {}) } }
}

/** «6 may 2027», o «3 may» si es de este año: un día civil, sin corrimiento de zona. */
export function controlDaySaid(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const thisYear = clinicDateTimeValue(new Date().toISOString()).slice(0, 4) === day.slice(0, 4)
  return new Intl.DateTimeFormat(activeOrgLocale() ?? "es", {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  })
    .format(new Date(Date.UTC(year, month - 1, date, 12)))
    .replace(".", "")
}

/** El día de un instante en la zona de la clínica. */
const dayOf = (iso: string): string => clinicDateTimeValue(iso).slice(0, 10)

/** «Control de mantenimiento» → «control de mantenimiento», para decirlo en una frase. */
const inSentence = (title: string): string => (/^\p{Lu}\p{Ll}/u.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title)

/**
 * «¿Cuándo vuelve?» al firmar (ADR 0152), justo antes de firmar: los controles
 * que esta visita cumple, como casillas, y los atajos para el próximo. Ninguno
 * viene marcado y se firma igual sin elegir. Si ya tiene un control (o Clío
 * dictó uno), en vez de preguntar dice cuándo vuelve, con «Cambiar».
 */
export function ClosingNextVisit({
  form,
  controls,
  dictated = null,
  busy,
  onChangeDictated,
}: {
  form: ClosingForm
  controls: ClosingControls | null | undefined
  /** El control de Clío marcado para entrar con la firma, si hay. */
  dictated?: DictatedControl | null
  busy: boolean
  /** «Cambiar» sobre lo que dictó Clío: abre la sugerencia para corregirla. */
  onChangeDictated?: (id: string) => void
}): React.JSX.Element | null {
  const ids = useId()
  const values = useStore(form.store, (state) => state.values)
  if (!controls) return null
  const known = knownReturn(values, controls, dictated)
  const asking = asksNextControl(values, known)
  const recall = controls.recallMonths
  const options: Array<{ value: Exclude<NextControlChoice, "">; label: string }> = [
    { value: "week", label: "En 1 semana" },
    { value: "month", label: "En 1 mes" },
    { value: "recall", label: recall === 12 ? "En 1 año" : `En ${recall} meses` },
    { value: "date", label: "Otra fecha" },
    // Cambiar el que ya tiene no es quitarlo: eso se hace en «Plan y controles».
    ...(known ? [] : [{ value: "none" as const, label: "No hace falta" }]),
  ]
  const tomorrow = dayOf(new Date(Date.now() + 86_400_000).toISOString())
  const set = <K extends keyof ClosingValues>(name: K, value: ClosingValues[K]) => form.setFieldValue(name, value as never)
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
          <FieldDescription>Por qué: cualquier atención desde unos días antes de su fecha le sirve.</FieldDescription>
        </FieldSet>
      ) : null}
      <div className="flex flex-col gap-2">
        <p id={`${ids}-cuando`} className="font-medium">
          ¿Cuándo vuelve?
        </p>
        {known && !asking ? (
          <p className="text-sm">
            {known.kind === "dictated" ? (
              <>
                Vuelve el {controlDaySaid(known.day)}, como dictaste
                {onChangeDictated ? (
                  <>
                    {" · "}
                    <Button
                      type="button"
                      size="sm"
                      variant="link"
                      className="h-auto p-0"
                      disabled={busy}
                      onClick={() => onChangeDictated(known.id)}
                    >
                      Cambiar
                    </Button>
                  </>
                ) : null}
              </>
            ) : known.kind === "repeats" ? (
              `Su control se repite: el siguiente queda para ${recallWords(known.months)}.`
            ) : known.kind === "stays" ? (
              `Sigue pendiente su ${inSentence(known.control.title)} del ${controlDaySaid(dayOf(known.control.dueAt))}: recepción lo verá.`
            ) : known.control.scheduledAt ? (
              `Vuelve el ${controlDaySaid(dayOf(known.control.scheduledAt))}, con su cita.`
            ) : (
              <>
                Vuelve el {controlDaySaid(dayOf(known.control.dueAt))}
                {" · "}
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="h-auto p-0"
                  disabled={busy}
                  onClick={() => set("nextControlChange", true)}
                >
                  Cambiar
                </Button>
              </>
            )}
          </p>
        ) : (
          <>
            <ChoiceButtons
              aria-labelledby={`${ids}-cuando`}
              value={values.nextControl || null}
              options={options}
              disabled={busy}
              onChange={(next) => set("nextControl", next)}
              onClear={() => set("nextControl", "")}
            />
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
            {values.nextControl === "" ? (
              <p className="text-xs text-muted-foreground">
                {known?.kind === "control"
                  ? `Si no eliges, sigue el ${controlDaySaid(dayOf(known.control.dueAt))}.`
                  : "No indicaste cuándo vuelve: recepción no lo verá"}
              </p>
            ) : null}
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
  children,
  nextVisit = null,
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
  /** Lo que se suma al cierre (el aviso del dictado, por ejemplo). */
  children?: React.ReactNode
  /** «¿Cuándo vuelve?», justo encima de firmar. */
  nextVisit?: React.ReactNode
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
      <DialogContent aria-describedby={`${ids}-desc`} className="sm:max-w-lg" initialFocus={initialFocus}>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Finalizar y firmar</DialogTitle>
            <DialogDescription id={`${ids}-desc`}>
              Después del cierre solo se agregan adendas. Si vino de una cita, la cita queda atendida.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 text-sm">
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
            {closing ? <ProductClosing closing={closing} pending={busy} openBlock={onOpenBlock} /> : null}
            {materials && materials.items.length > 0 ? (
              <p className="rounded-lg border p-3">
                <span className="font-medium">Materiales</span>
                {" · "}
                {closingMaterialsWords(materials, activeOrgLocale() ?? "es")}
              </p>
            ) : null}
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
