import { Button } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { QueryErrorState } from "../../lib/query-error"
import { WRITING_HOURS_KEY, type WritingWeek, writingWeekRows } from "../../lib/writing-hours"
import { useWeeklyTurns, type WeeklyRule, WeeklyScheduleFields } from "../agenda/schedule-editor"

function rulesOf(week: WritingWeek): WeeklyRule[] {
  return week.flatMap((ranges, weekday) => ranges.map(([startMin, endMin]) => ({ weekday, startMin, endMin })))
}

function weekOf(rules: WeeklyRule[]): WritingWeek {
  const week: WritingWeek = Array.from({ length: 7 }, () => [])
  for (const rule of rules) week[rule.weekday]?.push([rule.startMin, rule.endMin])
  return week
}

export function useWritingHours(enabled = true) {
  return useQuery({
    queryKey: WRITING_HOURS_KEY,
    queryFn: () => apiFetch<{ data: { week: WritingWeek } }>("/api/agent/writing-hours"),
    enabled,
  })
}

/** La semana en palabras: «Lunes a viernes 8:00 a 20:00 · Escribimos». */
export function WritingHoursRows({ week }: { week: WritingWeek }) {
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {writingWeekRows(week).map((row) => (
        <li key={row.days} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 basis-40 font-semibold">
            {row.days}
            <span className="font-normal text-muted-foreground"> {row.hours ?? "—"}</span>
          </span>
          <span className={row.hours ? "text-sm font-semibold text-success" : "text-sm text-muted-foreground"}>
            {row.hours ? "Escribimos" : "No escribimos"}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Agente › «Horario para escribir» (decisión 18 v3): cuándo odentIA escribe por
 * su cuenta, por día y con la hora de cada sede. Se cambia con el mismo editor
 * semanal de los horarios del equipo. No es el horario de atención ni «A qué
 * horas responde» el agente.
 */
export function WritingHoursCard({ canWrite }: { canWrite: boolean }) {
  const query = useWritingHours()
  const [open, setOpen] = useState(false)
  const week = query.data?.data.week
  return (
    <section aria-labelledby="horario-para-escribir" className="elevated flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id="horario-para-escribir" className="font-heading text-base font-bold sm:text-lg">
            Horario para escribir
          </h2>
          <p className="text-sm text-muted-foreground">
            Cuándo odentIA escribe por su cuenta: recordatorios, controles, seguimientos, novedades y lo que inicia el agente.
            Con la hora de cada sede. No cambia cuándo responde el agente cuando la persona escribe.
          </p>
        </div>
        {canWrite && week ? (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setOpen(true)}>
            Cambiar
          </Button>
        ) : null}
      </div>
      {query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : week ? (
        <WritingHoursRows week={week} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Cargando el horario…
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Si un mensaje toca fuera de este horario, sale en el último momento permitido antes o, si no hay, en el primero después, siempre que falte al
        menos una hora para la cita. Los avisos de algo que pasó, como una cita cancelada, salen al momento.{" "}
        <Link to="/agent/recepcion" className="font-semibold text-primary underline-offset-4 hover:underline">
          A qué horas responde
        </Link>{" "}
        va aparte, en Recepción.
      </p>
      {open && week ? <WritingHoursDrawer week={week} onClose={() => setOpen(false)} /> : null}
    </section>
  )
}

function WritingHoursDrawer({ week, onClose }: { week: WritingWeek; onClose: () => void }) {
  const queryClient = useQueryClient()
  const schedule = useWeeklyTurns({
    key: "horario-para-escribir",
    rules: rulesOf(week),
    failed: false,
    retry: () => undefined,
    save: (rules) => apiFetch("/api/agent/writing-hours", { method: "PUT", body: JSON.stringify({ week: weekOf(rules) }) }),
    savedMessage: "Horario para escribir guardado",
    onSaved: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WRITING_HOURS_KEY }),
        queryClient.invalidateQueries({ queryKey: ["agent-admin"] }),
      ])
      onClose()
    },
  })
  return (
    <FormDrawer
      open
      title="Horario para escribir"
      description="Por día, con la hora de cada sede. Un día sin tramos no se escribe."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        schedule.save()
      }}
      isSubmitting={schedule.saving}
      isDirty={schedule.dirty}
      error={schedule.error || null}
      submitDisabled={!schedule.ready || !schedule.dirty}
      submitLabel="Guardar horario"
      cancelLabel={schedule.dirty ? "Cancelar" : "Cerrar"}
    >
      <WeeklyScheduleFields schedule={schedule} canEdit stacked emptyLabel="No escribimos" unit="tramo" />
    </FormDrawer>
  )
}
