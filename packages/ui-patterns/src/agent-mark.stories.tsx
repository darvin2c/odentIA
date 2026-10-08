import { Badge, Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { AgentMark, AgentSurface } from "./agent-mark.js"

/**
 * Identidad del agente: la marca acompaña a un texto que ya lo nombra y la
 * superficie agrupa lo que espera una decisión del equipo.
 */
const meta = {
  title: "Patrones/AgentMark",
  parameters: { layout: "padded" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Marca: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <AgentMark />
      <span className="flex items-center gap-2 text-sm">
        <AgentMark size="sm" /> Agente
      </span>
    </div>
  ),
}

export const SuperficieConPropuesta: Story = {
  render: () => (
    <AgentSurface aria-label="Pendiente de ti" className="max-w-2xl">
      <div className="mb-4 flex items-center gap-3">
        <AgentMark />
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold">
            Pendiente de ti <Badge>1 por revisar</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            Propuestas del agente y casos que derivó al equipo.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card p-4">
        <div className="min-w-0">
          <p className="font-medium">Reprogramar cita</p>
          <p className="text-sm text-muted-foreground">
            Carmen Rojas · interlocutora con un nombre largo que debe envolver sin desbordar
          </p>
        </div>
        <Button size="sm">Revisar y aprobar</Button>
      </div>
    </AgentSurface>
  ),
}
