import { conditionLabel, SIGNED_ODONTOGRAM_PURPOSE_LABELS } from "@odentia/clinical"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Textarea,
} from "@odentia/ui"
import { TimeSelect } from "@odentia/ui-patterns"
import { useId } from "react"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
import type { ConsentNeed } from "../../lib/encounter-documents"
import type { ClosingOdontogram } from "../../lib/encounters"

/** «16, 26 y 36». */
function teethWords(teeth: number[]): string {
  if (teeth.length <= 1) return teeth.join("")
  return `${teeth.slice(0, -1).join(", ")} y ${teeth.at(-1)}`
}

/** «Hallazgos: lesión de caries dental en 16, 26 y 36». */
function findingsLine(odontogram: ClosingOdontogram): string | null {
  if (odontogram.findings.length === 0) return null
  const parts = odontogram.findings.map((group) => {
    const label = conditionLabel(group.condition)
    return `${label.charAt(0).toLowerCase()}${label.slice(1)} en ${teethWords(group.teeth)}`
  })
  return `Hallazgos: ${parts.join("; ")}`
}

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
 * (firmarlo ahora o seguir sin él diciendo por qué), en clínicas de Perú el
 * odontograma que queda firmado con su momento (fase 3, paso 5), la hora de
 * fin y, después de firmar, lo que quedó por cobrar.
 */
export function EncounterClosingDialog({
  open,
  signAs,
  who,
  consents,
  odontogram = null,
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
  children,
}: {
  open: boolean
  /** «Ana Torres · Cirujano dentista · COP 12345», de su perfil. */
  signAs: string | null
  /** Primer nombre de quien firma el consentimiento. */
  who: string
  consents: ConsentNeed[]
  /** En clínicas de Perú, el odontograma que firmará este cierre. */
  odontogram?: ClosingOdontogram | null
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
  /** Lo que se suma al cierre (el aviso del dictado, por ejemplo). */
  children?: React.ReactNode
}): React.JSX.Element {
  const ids = useId()
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
      <DialogContent aria-describedby={`${ids}-desc`} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Finalizar y firmar</DialogTitle>
          <DialogDescription id={`${ids}-desc`}>
            Después del cierre solo se agregan adendas. Si vino de una cita, la cita queda atendida.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <div className="rounded-lg border p-3">
            <p className="font-medium">Firmarás como {signAs ?? "—"}</p>
            <p className="text-xs text-muted-foreground">De tu perfil profesional</p>
          </div>
          {odontogram ? (
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <Badge variant="outline">{odontogram.shortName}</Badge>
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">
                  El odontograma queda firmado como «{SIGNED_ODONTOGRAM_PURPOSE_LABELS[odontogram.purpose]}»
                </span>
                {findingsLine(odontogram) ? (
                  <span className="text-xs text-muted-foreground">{findingsLine(odontogram)}</span>
                ) : null}
              </div>
            </div>
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
            {pending ? "Firmando…" : "Finalizar y firmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
