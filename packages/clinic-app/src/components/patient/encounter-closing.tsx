import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Textarea,
} from "@odentia/ui"
import { TimeSelect } from "@odentia/ui-patterns"
import { useId } from "react"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
import type { ConsentNeed } from "../../lib/encounter-documents"
import {
  type ClosingCheck,
  type ClosingMaterials,
  type SignatureRegistration,
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
 * después de firmar, lo que quedó por cobrar.
 */
export function EncounterClosingDialog({
  open,
  signAs,
  who,
  consents,
  closing = null,
  materials = null,
  onOpenBlock,
  startedAt,
  endTime,
  onEndTime,
  skipReason,
  onSkipReason,
  pending,
  canSign,
  blockedReason,
  onSignNow,
  onConfirm,
  onClose,
  registration = null,
  confirmLabel = null,
  initialFocus,
  children,
}: {
  open: boolean
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
  /** Vuelve a la atención con un bloque abierto (odentIA: «Seguir midiendo» el periodontograma). */
  onOpenBlock: (key: string) => void
  startedAt: string | null | undefined
  /** «HH:MM»; vacío = ahora. */
  endTime: string
  onEndTime: (value: string) => void
  skipReason: string
  onSkipReason: (value: string) => void
  pending: boolean
  canSign: boolean
  /** Por qué aún no se puede firmar (sin guardar, sin conexión…). */
  blockedReason: string | null
  onSignNow: (need: ConsentNeed) => void
  onConfirm: () => void
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
  const ready = canSign && !pending && (!needsReason || skipReason.trim().length > 0)
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !pending) onClose()
      }}
    >
      <DialogContent aria-describedby={`${ids}-desc`} className="sm:max-w-lg" initialFocus={initialFocus}>
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
          {closing ? <ProductClosing closing={closing} pending={pending} openBlock={onOpenBlock} /> : null}
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
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onSignNow(need)}>
                    Firmar ahora
                  </Button>
                ) : null}
              </div>
            )
          })}
          {needsReason ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-skip`}>Seguir sin él: ¿por qué?</FieldLabel>
              <Textarea
                id={`${ids}-skip`}
                rows={2}
                maxLength={2000}
                placeholder="Ej.: urgencia, se firmará en la próxima visita"
                value={skipReason}
                onChange={(event) => onSkipReason(event.target.value)}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${ids}-end`}>Hora de fin</FieldLabel>
            <TimeSelect
              id={`${ids}-end`}
              className="w-44"
              min={bounds.min}
              max={bounds.max}
              emptyLabel={`Ahora (${bounds.max})`}
              value={endTime}
              onChange={onEndTime}
            />
          </Field>
          {children}
          {blockedReason ? (
            <p role="status" className="text-xs text-muted-foreground">
              {blockedReason}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Después: lo que quedó por cobrar, para avisar a caja.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Volver
          </Button>
          <Button type="button" disabled={!ready} onClick={onConfirm}>
            {pending ? "Firmando…" : (confirmLabel ?? productUi().encounter.signLabel(closing) ?? "Finalizar y firmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/**
 * Sin colegiatura no se firma (ADR 0003: nombre y colegiatura en cada
 * atención): se pide en el mismo cierre, sin salir de la atención, y se
 * guarda en el perfil profesional para las siguientes. El título solo se pide
 * si el perfil no lo tiene; el colegio viene propuesto por el país del
 * producto (COP en odentIA, CMP en latidIA) y se puede cambiar.
 */
export function SignatureRegistrationFields({
  signAs,
  values,
  askTitle,
  error,
  disabled,
  numberRef,
  onChange,
}: {
  /** El nombre con que firma, de su cuenta o su perfil. */
  signAs: string | null
  values: SignatureRegistration
  askTitle: boolean
  error: string | null
  disabled: boolean
  /** El número es lo que falta escribir: ahí empieza el foco. */
  numberRef?: React.Ref<HTMLInputElement>
  onChange: (values: SignatureRegistration) => void
}): React.JSX.Element {
  const ids = useId()
  const set = (key: keyof SignatureRegistration, value: string) => onChange({ ...values, [key]: value })
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning-soft p-3">
      <div className="flex flex-col">
        <p className="font-medium">Falta tu colegiatura para firmar</p>
        <p className="text-xs text-muted-foreground">
          {signAs ? `Firmarás como ${signAs}. ` : ""}La historia clínica pide nombre y colegiatura.
        </p>
      </div>
      {askTitle ? (
        <Field>
          <FieldLabel htmlFor={`${ids}-title`}>Título profesional</FieldLabel>
          <Input
            id={`${ids}-title`}
            maxLength={120}
            disabled={disabled}
            value={values.professionalTitle}
            onChange={(event) => set("professionalTitle", event.target.value)}
          />
        </Field>
      ) : null}
      <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-3">
        <Field>
          <FieldLabel htmlFor={`${ids}-body`}>Colegio</FieldLabel>
          <Input
            id={`${ids}-body`}
            maxLength={120}
            disabled={disabled}
            value={values.registrationBody}
            onChange={(event) => set("registrationBody", event.target.value)}
          />
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-number`}>Número de colegiatura</FieldLabel>
          <Input
            id={`${ids}-number`}
            ref={numberRef}
            inputMode="numeric"
            autoComplete="off"
            maxLength={20}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids}-error` : `${ids}-help`}
            value={values.registrationNumber}
            onChange={(event) => set("registrationNumber", event.target.value)}
          />
        </Field>
      </div>
      {error ? (
        <FieldError id={`${ids}-error`}>{error}</FieldError>
      ) : (
        <FieldDescription id={`${ids}-help`}>Se guarda en tu perfil profesional: no la volverá a pedir.</FieldDescription>
      )}
    </div>
  )
}
