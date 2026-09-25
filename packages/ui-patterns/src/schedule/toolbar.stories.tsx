import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { CalendarDays, CalendarRange, Columns3, LayoutGrid, Rows3 } from "lucide-react"
import * as React from "react"

import { DemoStage } from "../story-fixtures.js"
import { ScheduleToolbar } from "./toolbar.js"

/**
 * La barra de la agenda: contexto, navegación, «Hoy», conmutador de vista con
 * `aria-pressed` y una sola acción principal. El conmutador cambia la vista
 * de verdad en la demo.
 */
const meta = {
  title: "Patrones/Agenda/Barra",
  parameters: { layout: "fullscreen" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const VISTAS = [
  { id: "dia", label: "Día", icon: <CalendarDays /> },
  { id: "semana", label: "Semana", icon: <CalendarRange /> },
  { id: "timeline", label: "Timeline", icon: <Rows3 /> },
  { id: "tablero", label: "Tablero", icon: <Columns3 /> },
  { id: "mes", label: "Mes", icon: <LayoutGrid /> },
]

function BarraCompleta() {
  const [view, setView] = React.useState("dia")
  const [pagina, setPagina] = React.useState(0)
  return (
    <div className="flex flex-col gap-4">
      <ScheduleToolbar
        context={
          <>
            <span className="text-sm font-medium">Sede Miraflores</span>
            <span className="text-xs text-muted-foreground">America/Lima (GMT-5)</span>
          </>
        }
        rangeLabel="Lunes 21 de setiembre"
        onPrevious={() => setPagina((p) => p - 1)}
        onNext={() => setPagina((p) => p + 1)}
        onToday={() => setPagina(0)}
        views={VISTAS}
        view={view}
        onViewChange={setView}
        action={<Button size="sm">Nueva cita</Button>}
      />
      <p className="text-sm text-muted-foreground">
        Vista: {view} · página: {pagina}
      </p>
    </div>
  )
}

export const Completa: Story = {
  render: () => (
    <DemoStage className="h-auto">
      <BarraCompleta />
    </DemoStage>
  ),
}

/** Lo mínimo: rango y navegación, sin contexto ni conmutador. */
export const Minima: Story = {
  render: () => (
    <DemoStage className="h-auto">
      <ScheduleToolbar rangeLabel="Setiembre de 2026" onPrevious={() => {}} onNext={() => {}} />
    </DemoStage>
  ),
}
