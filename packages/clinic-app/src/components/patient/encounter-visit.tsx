/**
 * «Hoy viene a…» (QA de la atención del 8 nov, propuesta 4.1): arriba de la
 * atención, con o sin cita, lo que el servidor sabe que la persona viene a
 * hacer: lo que trae su cita, sus tratamientos aceptados por hacer con la
 * sesión que le toca y los controles por cumplir. Un toque prepara la atención
 * (motivo, diagnóstico que sigue, el tratamiento en «Realizado hoy»); nada se da
 * por hecho: la sesión cuenta al registrarla y el control se cumple al firmar.
 */
import { gapWords } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useState } from "react"
import { bringTreatmentApi, chooseVisitControlApi, leaveTreatmentApi } from "../../lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { type EncounterVisit, treatmentConsentWords, type VisitControl, type VisitTreatment } from "../../lib/patients"

/** «4 may», en la zona de la clínica. */
function shortDay(iso: string): string {
  return new Date(iso)
    .toLocaleDateString(activeOrgLocale(), {
      day: "numeric",
      month: "short",
      timeZone: activeOrgTimeZone(),
    })
    .replace(".", "")
}

/** «Endodoncia anterior vital · 46 · sesión 2 de 2». */
export function visitTreatmentWords(item: VisitTreatment): string {
  return [
    item.title,
    item.toothNumber != null ? String(item.toothNumber) : null,
    item.m > 1 ? `sesión ${item.n} de ${item.m}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
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

/** «vencido el 4 may · lo indicó Dr. Hugo». */
function controlWords(control: VisitControl): string {
  return [
    control.overdue
      ? `vencido el ${shortDay(control.dueAt)}`
      : `toca el ${shortDay(control.dueAt)}`,
    control.byName ? `lo indicó ${control.byName}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
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
  onUrgency,
  disabled,
  beforeWrite,
  onChanged,
  onPendingChange,
}: {
  patientId: string
  encounterId: string
  visit: EncounterVisit | null | undefined
  /** El motivo que trae la cita, mientras no haya otro. */
  offeredReason: string | null
  /** El de la cita aunque ya se usó: lo usado sigue a la vista (QA del 9 nov, repaso 3). */
  bookedReason?: string | null
  onUseReason: () => void
  reasonEmpty: boolean
  /** «Es una urgencia»: deja el motivo listo para escribir. */
  onUrgency: () => void
  disabled: boolean
  beforeWrite: () => Promise<void>
  onChanged: () => Promise<void>
  /** Escribe en la atención: firmar espera a que termine. */
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const treatments = visit?.treatments ?? []
  const controls = visit?.controls ?? []
  // Ya usado como motivo, «Su cita» sigue a la vista, sin botón.
  const usedReason = !offeredReason && bookedReason?.trim() ? bookedReason.trim() : null
  const nothing = treatments.length === 0 && controls.length === 0 && !offeredReason && !usedReason

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

  return (
    <section
      aria-labelledby={`${encounterId}-visit`}
      className="flex flex-col gap-1 rounded-sm bg-card px-6 py-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${encounterId}-visit`} className="font-heading text-base font-medium">
          Hoy viene a…
        </h2>
        {reasonEmpty ? (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onUrgency}>
            Es una urgencia
          </Button>
        ) : null}
      </div>
      {visit?.booked ? (
        // Sin cita hoy, pero ya tiene una reservada: se dice, para no reservarle otra sin saberlo (QA del 9 nov).
        <p className="text-sm text-muted-foreground">
          {`Hoy vino sin cita. Ya tiene una reservada: ${new Date(visit.booked.startsAt)
            .toLocaleDateString(activeOrgLocale(), { weekday: "short", day: "numeric", month: "short", timeZone: activeOrgTimeZone() })
            .replace(/[.,]/g, "")}, ${new Date(visit.booked.startsAt).toLocaleTimeString(activeOrgLocale(), {
            hour: "numeric",
            minute: "2-digit",
            timeZone: activeOrgTimeZone(),
          })}${visit.booked.serviceName ? ` · ${visit.booked.serviceName}` : ""}.`}
        </p>
      ) : null}
      {nothing ? (
        <p className="text-sm text-muted-foreground">
          {visit?.booked
            ? "Sin tratamiento por hacer ni control por cumplir. Escribe el motivo abajo."
            : "Sin cita, tratamiento por hacer ni control por cumplir. Escribe el motivo abajo."}
        </p>
      ) : (
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
                  const continuing = treatments.find(
                    (item) => item.linked && item.broughtByAppointment && item.started && !item.registered,
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
          {treatments.map((item) => {
            const words = visitTreatmentWords(item)
            return (
              <li key={item.planItemId} className={row}>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{words}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.registered
                      ? "Sesión de hoy registrada en «Realizado hoy»"
                      : item.linked
                        ? "Está en «Realizado hoy»: ahí registras su sesión cuando la hagas"
                        : item.started
                          ? "En curso"
                          : item.after
                            ? // La misma regla de «Qué sigue»: avisa, y «Hacerla hoy» queda como segunda opción.
                              `Aceptado · va después de terminar ${item.after.title}${item.after.today ? ", que se hace hoy" : ""}`
                            : "Aceptado, sin empezar"}
                  </span>
                  {!item.registered && visitWaitWords(item) ? (
                    <span className="text-xs text-warning">{visitWaitWords(item)}</span>
                  ) : null}
                  {/* El consentimiento va con el tratamiento: se firma antes de empezar, en Documentos. */}
                  {!item.registered && treatmentConsentWords(item.consent) ? (
                    <span className={item.consent === "firmado" ? "text-xs text-muted-foreground" : "text-xs text-warning"}>
                      {treatmentConsentWords(item.consent)}
                    </span>
                  ) : null}
                </span>
                {item.registered ? null : item.linked ? (
                  <span className="flex flex-wrap gap-2">
                    {item.broughtByAppointment ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled || busy !== null}
                        aria-label={`Hoy no: ${words}`}
                        onClick={() =>
                          void run(item.planItemId, () =>
                            leaveTreatmentApi(patientId, encounterId, item.planItemId),
                          )
                        }
                      >
                        Hoy no
                      </Button>
                    )}
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || busy !== null}
                    aria-label={`${item.started ? "Continuar hoy" : "Hacerla hoy"}: ${words}`}
                    onClick={() =>
                      void run(item.planItemId, () =>
                        bringTreatmentApi(patientId, encounterId, item.planItemId),
                      )
                    }
                  >
                    {busy === item.planItemId
                      ? "Preparando…"
                      : item.started
                        ? "Continuar hoy"
                        : "Hacerla hoy"}
                  </Button>
                )}
              </li>
            )
          })}
          {visit && visit.moreTreatments > 0 ? (
            <li className="py-2 text-xs text-muted-foreground">
              Y {visit.moreTreatments}{" "}
              {visit.moreTreatments === 1
                ? "tratamiento aceptado más"
                : "tratamientos aceptados más"}{" "}
              en su Plan.
            </li>
          ) : null}
          {controls.map((control) => (
            <li key={control.id} className={row}>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{control.title}</span>
                <span
                  className={
                    control.overdue ? "text-xs text-warning" : "text-xs text-muted-foreground"
                  }
                >
                  {controlWords(control)}
                  {control.byAppointment
                    ? " · su cita de hoy es este control: se cumple al firmar"
                    : control.chosen
                      ? " · viene a este control: se cumple al firmar"
                      : ""}
                </span>
              </span>
              {control.byAppointment ? null : control.chosen ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled || busy !== null}
                  aria-label={`No viene a ${control.title}`}
                  onClick={() =>
                    void run(control.id, () => chooseVisitControlApi(patientId, encounterId, null))
                  }
                >
                  No es este
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || busy !== null}
                  aria-label={`Viene a su control: ${control.title}`}
                  onClick={() =>
                    void run(control.id, () =>
                      chooseVisitControlApi(patientId, encounterId, control.id),
                    )
                  }
                >
                  {busy === control.id ? "Anotando…" : "Viene a su control"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!nothing ? (
        <p className="text-xs text-muted-foreground">
          Elegir no lo da por hecho: la sesión cuenta cuando la registras y el control, al firmar.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
