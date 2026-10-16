import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { useId } from "react"
import { clinicDateTimeValue } from "../../lib/clinical-journey"
import type { ConsentNeed } from "../../lib/encounter-documents"

/** Horas de fin posibles: de 5 en 5 minutos, desde el inicio hasta ahora, en la zona de la clínica. */
export function endTimeOptions(startedAt: string | null | undefined, now = new Date()): string[] {
  const nowValue = clinicDateTimeValue(now.toISOString())
  const today = nowValue.slice(0, 10)
  const [nh, nm] = nowValue.slice(11, 16).split(":").map(Number) as [number, number]
  const end = nh * 60 + nm
  let begin = 0
  if (startedAt) {
    const startValue = clinicDateTimeValue(startedAt)
    // Una atención de otro día termina hoy desde las 00:00; la de hoy, desde su inicio.
    if (startValue.slice(0, 10) === today) {
      const [sh, sm] = startValue.slice(11, 16).split(":").map(Number) as [number, number]
      begin = Math.ceil((sh * 60 + sm) / 5) * 5
    }
  }
  const out: string[] = []
  for (let minute = end - (end % 5); minute >= begin && out.length < 96; minute -= 5) {
    out.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`)
  }
  return out
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
 * (firmarlo ahora o seguir sin él diciendo por qué), la hora de fin y, después
 * de firmar, lo que quedó por cobrar. El paso 3 suma aquí «¿Enviarle el
 * presupuesto?» (`after`).
 */
export function EncounterClosingDialog({
  open,
  signAs,
  who,
  consents,
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
  const options = endTimeOptions(startedAt)
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
            <Select
              items={Object.fromEntries([["", `Ahora${options[0] ? ` (${options[0]})` : ""}`], ...options.map((o) => [o, o])])}
              value={endTime}
              onValueChange={(value) => onEndTime(value ?? "")}
            >
              <SelectTrigger id={`${ids}-end`} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Ahora{options[0] ? ` (${options[0]})` : ""}</SelectItem>
                {options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
