/**
 * Por qué viene, dentro de Consulta (la atención agrupada, 17 nov; antes «Hoy viene a…»): lo que
 * trae su cita, lo que contó antes de venir y, sin cita, la que ya tiene reservada. «Usar como
 * motivo» llena el motivo solo si está vacío y, si su cita continúa un tratamiento, trae su
 * diagnóstico. Los tratamientos y los controles de hoy están en el Plan, en su fila. Sin nada
 * que decir no se muestra (estándar E2).
 */
import { gapWords, visitReasonForEncounter } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useState } from "react"
import { bringTreatmentApi } from "../../lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import type { EncounterVisit, EncounterVisitAnswerView, VisitTreatment } from "../../lib/patients"
import { visitPainWords, visitToldHeading } from "../../lib/visit-answer-words"

/**
 * «Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 3:00 p. m. · Limpieza.» La frase
 * cierra con un solo punto: la hora «p. m.» ya trae el suyo.
 */
export function visitBookedWords(
  booked: { startsAt: string; serviceName: string | null },
  locale: string | undefined,
  timeZone: string,
): string {
  const starts = new Date(booked.startsAt)
  const day = starts.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).replace(/[.,]/g, "")
  const time = starts.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone })
  const words = `Hoy vino sin cita. Ya tiene una reservada: ${day}, ${time}${booked.serviceName ? ` · ${booked.serviceName}` : ""}`
  return words.endsWith(".") ? words : `${words}.`
}

/**
 * La espera entre sesiones que aún no se cumple (QA del 10 nov, B6), con los días que pide su
 * servicio: «La sesión anterior fue hoy: la medicación suele dejarse una semana.». Avisa y no
 * traba: «Continuar hoy» sigue. Null si no hay espera pendiente.
 */
export function visitWaitWords(item: Pick<VisitTreatment, "wait">): string | null {
  const wait = item.wait
  if (!wait) return null
  const when =
    wait.sinceDays === 0 ? "hoy" : wait.sinceDays === 1 ? "ayer" : `hace ${wait.sinceDays} días`
  return `La sesión anterior fue ${when}: la medicación suele dejarse ${gapWords(wait.days)}.`
}

const row = "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"

export function EncounterVisitStrip({
  patientId,
  encounterId,
  visit,
  offeredReason,
  bookedReason,
  onUseReason,
  reasonEmpty,
  disabled,
  beforeWrite,
  onChanged,
  onPendingChange,
  past = false,
  visitAnswer = null,
  patientFirstName = null,
  onUseVisitReason,
  currentReason = "",
}: {
  /** El motivo de consulta escrito: si ya es lo que contó, se dice «Ya es el motivo de hoy». */
  currentReason?: string
  /** La atención es de otro día (una cita pasada que se registra después): no se dice «hoy». */
  past?: boolean
  /**
   * Lo que contó antes de venir («Antes de tu cita»): para la cita de esta atención o, si vino sin
   * cita o antes, para otra cita suya (`otherAppointment`), dicho con su fecha.
   */
  visitAnswer?: EncounterVisitAnswerView | null
  patientFirstName?: string | null
  /**
   * «Usar como motivo» con sus palabras: solo con el motivo vacío, nunca pisa lo escrito (ni lo que
   * anotó recepción, que sigue a la vista).
   */
  onUseVisitReason?: (reason: string) => void
  patientId: string
  encounterId: string
  visit: EncounterVisit | null | undefined
  /** El motivo que trae la cita, mientras no haya otro. */
  offeredReason: string | null
  /** El de la cita aunque ya se usó: lo usado sigue a la vista (QA del 9 nov, repaso 3). */
  bookedReason?: string | null
  onUseReason: () => void
  reasonEmpty: boolean
  disabled: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  /** Escribe en la atención: firmar espera a que termine. */
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Su cita: lo que continúa (la sesión 2) también trae su diagnóstico al usarla como motivo.
  const allTreatments = visit?.treatments ?? []
  // Ya usado como motivo, «Su cita» sigue a la vista, sin botón.
  const usedReason = !offeredReason && bookedReason?.trim() ? bookedReason.trim() : null
  // Sus palabras se ofrecen como motivo mientras no haya otro; usadas o con otro escrito, siguen a la vista.
  const toldReason = visitAnswer ? visitReasonForEncounter(visitAnswer) : null
  const nothing = !offeredReason && !usedReason && !visitAnswer

  const run = async (key: string, write: () => Promise<unknown>) => {
    if (busy) return
    setBusy(key)
    setError(null)
    onPendingChange(true)
    try {
      await beforeWrite()
      await write()
      await onChanged()
    } catch (err) {
      setError(submitErrorMessage(err))
    } finally {
      setBusy(null)
      onPendingChange(false)
    }
  }

  // Sin nada de antes, ni una cita ya reservada que decir, no hay tarjeta: el motivo se escribe en Consulta.
  if (nothing && !visit?.booked) return null

  return (
    <section aria-labelledby={`${encounterId}-visit`} className="flex flex-col gap-1">
      <h3 id={`${encounterId}-visit`} className="sr-only">
        {past ? "Por qué vino" : "Por qué viene"}
      </h3>
      {visit?.booked ? (
        // Sin cita hoy, pero ya tiene una reservada: se dice, para no reservarle otra sin saberlo (QA del 9 nov).
        <p className="text-sm text-muted-foreground">{visitBookedWords(visit.booked, activeOrgLocale(), activeOrgTimeZone())}</p>
      ) : null}
      {nothing ? null : (
        <ul className="flex flex-col divide-y text-sm">
          {usedReason ? (
            <li className={row}>
              <span className="min-w-0">
                <span className="text-muted-foreground">Su cita: </span>«{usedReason}»
                <span className="block text-xs text-muted-foreground">Ya es el motivo de hoy</span>
              </span>
            </li>
          ) : null}
          {offeredReason ? (
            <li className={row}>
              <span className="min-w-0">
                <span className="text-muted-foreground">Su cita: </span>«{offeredReason}»
              </span>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                aria-label={`Usar «${offeredReason}» como motivo`}
                onClick={() => {
                  onUseReason()
                  // Lo que su cita continúa (la sesión 2 de la endodoncia) trae también su
                  // diagnóstico, como «Continuar hoy» sin cita: la misma operación por los dos
                  // caminos (QA del 9 nov). El motivo escrito se guarda antes y no se pisa.
                  const continuing = allTreatments.find(
                    (item) =>
                      item.linked && item.broughtByAppointment && item.started && !item.registered,
                  )
                  if (continuing)
                    void run(continuing.planItemId, () =>
                      bringTreatmentApi(patientId, encounterId, continuing.planItemId),
                    )
                }}
              >
                Usar como motivo
              </Button>
            </li>
          ) : null}
          {visitAnswer ? (
            // «Antes de tu cita» (mesa del 13 nov, entrega 8): lo de esta cita o, si vino sin cita o
            // antes, lo que contó para otra cita suya, dicho como de esa cita (QA final, 15 nov, H2).
            <li className={row}>
              <span className="flex min-w-0 flex-col">
                <span className="text-xs text-muted-foreground">{visitToldHeading(visitAnswer, patientFirstName)}:</span>
                {visitAnswer.reason?.trim() ? <span>«{visitAnswer.reason.trim()}»</span> : null}
                {visitAnswer.toldPurpose && !visitAnswer.reason ? (
                  <span className="text-muted-foreground">Vino a: {visitAnswer.toldPurpose}</span>
                ) : null}
                {visitPainWords(visitAnswer) ? <span className="font-medium">{visitPainWords(visitAnswer)}</span> : null}
                {visitAnswer.more?.trim() ? <span className="text-muted-foreground">Además: «{visitAnswer.more.trim()}»</span> : null}
                {toldReason && !reasonEmpty && currentReason.trim() === toldReason ? (
                  <span className="text-xs text-muted-foreground">Ya es el motivo de hoy</span>
                ) : null}
              </span>
              {toldReason && reasonEmpty && onUseVisitReason ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Usar como motivo lo que contó: «${toldReason}»`}
                  onClick={() => onUseVisitReason(toldReason)}
                >
                  Usar como motivo
                </Button>
              ) : null}
            </li>
          ) : null}
        </ul>
      )}
      {/* Qué hace elegir (la sesión cuenta al registrarla; el control, al firmar) lo dicen sus
          botones y la Ayuda: con contenido, el bloque no repite su regla (estándar E2). */}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
