import type { Meta, StoryObj } from "@storybook/react"
import * as React from "react"

import { DemoStage } from "../story-fixtures.js"
import { daySegments } from "./occupancy.js"
import { ScheduleTeamWeek, ScheduleTeamWeekList, type ScheduleTeamRow } from "./team-week.js"
import { ScheduleOccupancyLegend } from "./week-overview.js"

/**
 * La semana del equipo: cuánto hay libre, la jornada en una barra y a qué hora
 * empieza cada hueco. Incluye quien no atiende un día, una ausencia y un día sin sitio.
 */
const meta = {
  title: "Patrones/Agenda/Semana del equipo",
  parameters: { layout: "fullscreen" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const DATES = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]
const WINDOW = { startMinutes: 480, endMinutes: 1200 }
const hours = (start: number, end: number) => [{ startMinutes: start, endMinutes: end }]

const row = (
  id: string,
  label: string,
  tone: ScheduleTeamRow["tone"],
  open: Array<[number, number] | null>,
  away?: number[],
): ScheduleTeamRow => ({
  id,
  label,
  tone,
  days: DATES.map((date, index) => {
    const range = open[index] ?? null
    const out = away?.includes(index) ?? false
    return {
      date,
      count: range && !out ? 3 : 0,
      ...(out ? { away: "Vacaciones", awayNote: "Hasta el viernes" } : {}),
      segments: daySegments({
        window: WINDOW,
        open: range && !out ? hours(range[0], range[1]) : [],
        busy:
          range && !out
            ? [
                { startMinutes: range[0] + 30, endMinutes: range[0] + 120 },
                { startMinutes: range[0] + 180, endMinutes: range[1] - 30 },
              ]
            : [],
      }),
    }
  }),
})

const ROWS: ScheduleTeamRow[] = [
  row("lucia", "Dra. Lucía Paredes", 0, [[540, 1140], [540, 1140], [540, 1140], [540, 1140], [540, 1140], [540, 780]]),
  row("andres", "Dr. Andrés Salas", 1, [[540, 1080], null, [540, 1080], null, [540, 1080], [540, 840]]),
  row("carla", "Dra. Carla Núñez", 2, [[540, 1020], [540, 1020], [540, 1020], [540, 1020], [540, 1020], null], [2, 3, 4]),
]

function Tabla() {
  const [selected, setSelected] = React.useState<{ columnId: string; date: string } | null>(null)
  return (
    <DemoStage>
      <div className="flex flex-col gap-3">
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <ScheduleTeamWeek
            rows={ROWS}
            dates={DATES}
            today="2026-11-02"
            selected={selected}
            onPick={(columnId, date) => setSelected({ columnId, date })}
            onResource={() => {}}
          />
        </div>
        <ScheduleOccupancyLegend />
      </div>
    </DemoStage>
  )
}

export const Escritorio: Story = { render: () => <Tabla /> }

export const Telefono: Story = {
  render: () => (
    <div className="max-w-[390px] bg-canvas p-3">
      <ScheduleTeamWeekList rows={ROWS} dates={DATES} today="2026-11-02" onPick={() => {}} />
    </div>
  ),
}
