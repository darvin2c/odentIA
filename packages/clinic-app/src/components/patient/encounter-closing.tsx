import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@odentia/ui"
import { TimeSelect, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useId, useRef } from "react"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
import type { ConsentNeed } from "../../lib/encounter-documents"
import {
  CLOSING_REQUIREMENT_LABELS,
  type ClosingCheck,
  type ClosingMaterials,
  type ClosingRequirement,
  type SignatureRegistration,
  signatureRegistrationErrors,
} from "../../lib/encounters"
import { activeOrgLocale } from "../../lib/locale"
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

/**
 * Lo que se escribe al cerrar: la hora de fin («HH:MM»; vacía = ahora), por qué
 * se sigue sin el consentimiento y, si el perfil no la tiene, la colegiatura.
 * Los nombres son los del cuerpo de `/finalize` y del perfil profesional, para
 * que cada rechazo del servidor caiga en su campo (`endedAt` → `endTime`).
 */
export interface ClosingValues extends SignatureRegistration {
  endTime: string
  consentSkipReason: string
}

/** El dato de `/finalize` que la pantalla llama de otro modo. */
export const CLOSING_FIELD_MAP = { endedAt: "endTime" } as const

const EMPTY_CLOSING: ClosingValues = {
  endTime: "",
  consentSkipReason: "",
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
}

/**
 * El formulario del cierre, el mismo para «Finalizar y firmar» y para firmar
 * con lo dictado. Lo escrito se conserva si el cierre falla; se vacía al
 * abrirlo de nuevo después de uno correcto (`form.reset`).
 */
export function useClosingForm(options: {
  /** Hay consentimientos sin firmar: se pide por qué se sigue sin ellos. */
  needsReason: boolean
  /** El perfil no tiene colegiatura: se pide aquí. */
  needsRegistration: boolean
  onSubmit: (value: ClosingValues) => Promise<void>
}) {
  const latest = useRef(options)
  latest.current = options
  return useAppForm({
    defaultValues: EMPTY_CLOSING,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (latest.current.needsReason && !value.consentSkipReason.trim())
          fields.consentSkipReason = "Escribe por qué sigues sin el consentimiento, o fírmalo ahora"
        if (latest.current.needsRegistration) Object.assign(fields, signatureRegistrationErrors(value))
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: ({ value }) => latest.current.onSubmit(value),
  })
}

export type ClosingForm = ReturnType<typeof useClosingForm>

/** Los valores con que se abre el cierre: lo que ya tiene el perfil y lo que propone el país. */
export function closingDefaults(registration: SignatureRegistration): ClosingValues {
  return { ...EMPTY_CLOSING, ...registration }
}

function consentLine(need: ConsentNeed, who: string): { title: string; detail: string } {
  if (need.status === "sin_publicar")
    return {
      title: `Esta clínica aún no publicó el consentimiento de «${need.title}»`,
      detail: "Fírmalo en papel y súbelo, o sigue sin él diciendo por qué",
    }
  if (need.status === "sin_preparar")
    return {
      title: `Falta el consentimiento de «${need.title}»`,
      detail: "Puedes firmarlo ahora o seguir sin él, diciendo por qué",
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
  registration = null,
  confirmLabel = null,
  initialFocus,
  children,
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
  /** Sin colegiatura en el perfil: se pide aquí, en lugar de «Firmarás como». */
  registration?: React.ReactNode
  /** «Guardar y firmar» cuando antes hay que guardar la colegiatura. */
  confirmLabel?: string | null
  /** Dónde empieza el foco al abrir (el número de colegiatura, si se pide). */
  initialFocus?: React.RefObject<HTMLElement | null>
  /** Lo que se suma al cierre (el aviso del dictado, por ejemplo). */
  children?: React.ReactNode
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
                      Firmar ahora
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
