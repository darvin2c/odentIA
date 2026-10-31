import { Button } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { QueryErrorState } from "../../lib/query-error"
import { WRITING_HOURS_KEY, type WritingWeek, writingWeekRows } from "../../lib/writing-hours"
import { type TurnDraft, useWeeklyTurns, type WeeklyRule, WeeklyScheduleFields } from "../agenda/schedule-editor"

/** Tramos por día que acepta el servidor (`MAX_RANGES_PER_DAY` de writing-hours). */
const MAX_RANGES_PER_DAY = 4

function rulesOf(week: WritingWeek): WeeklyRule[] {
  return week.flatMap((ranges, weekday) => ranges.map(([startMin, endMin]) => ({ weekday, startMin, endMin })))
}

function weekOf(rules: WeeklyRule[]): WritingWeek {
  const week: WritingWeek = Array.from({ length: 7 }, () => [])
  for (const rule of rules) week[rule.weekday]?.push([rule.startMin, rule.endMin])
  return week
}

/**
 * Lo que el servidor señala (`week[d]` el día, `week[d][j]` su j-ésimo tramo)
 * va a la hora final de ese tramo en el editor; un día, a su último tramo.
 */
function turnFieldOf(serverField: string, turns: TurnDraft[]): string | undefined {
  const match = /^week\[(\d+)\](?:\[(\d+)\])?/.exec(serverField)
  if (!match) return undefined
  const weekday = Number(match[1])
  const ofDay = turns.flatMap((turn, index) => (turn.weekday === weekday ? [index] : []))
  const index = match[2] === undefined ? ofDay.at(-1) : ofDay[Number(match[2])]
  return index === undefined ? undefined : `turns[${index}].to`
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
 * Agente › «Horario de recontacto» (decisión 18 v3; ADR 0084): cuándo se le
 * escribe primero a alguien, por día y con la hora de cada sede. Se cambia con
 * el mismo editor semanal de los horarios del equipo. Es el único horario: no
 * es el de atención, y cuando la persona escribe se le responde siempre.
 */
export function WritingHoursCard({ canWrite }: { canWrite: boolean }) {
  const query = useWritingHours()
  const receptionName = useReceptionName()
  const [open, setOpen] = useState(false)
  const week = query.data?.data.week
  return (
    <section aria-labelledby="horario-para-escribir" className="elevated flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id="horario-para-escribir" className="font-heading text-base font-bold sm:text-lg">
            Horario de recontacto
          </h2>
          <p className="text-sm text-muted-foreground">
            Es el horario decente para volver a contactar. {receptionName} solo escribe primero dentro de él: retomar lo que quedó pendiente,
            recordatorios, controles, seguimientos y novedades. Con la hora de cada sede. Cuando la persona escribe, {receptionName} responde
            siempre, a cualquier hora.
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
        menos una hora para la cita. Los avisos de algo que pasó, como una cita cancelada, salen al momento.
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
    maxPerDay: MAX_RANGES_PER_DAY,
    unit: "tramo",
    fieldMap: turnFieldOf,
    savedMessage: "Horario de recontacto guardado",
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
      title="Horario de recontacto"
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
