import type { Meta, StoryObj } from "@storybook/react"
import { FlowDiagram, type FlowDiagramStep } from "./flow-diagram.js"

/**
 * Flujo de una línea de Argos, el agente administrador. Se dibuja desde datos y solo
 * muestra lo que se ejecuta: aquí están los tres casos que existen (el agente
 * con su respaldo, el agente solo con el aviso, y solo una persona) y el flujo
 * detenido. Verlo también en estrecho: baja a una columna.
 */
const meta = {
  title: "Patrones/FlowDiagram",
  parameters: { layout: "padded" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const main: FlowDiagramStep[] = [
  { id: "inicio", kind: "inicio", label: "Una persona falta a su cita" },
  { id: "espera", kind: "paso", label: "Espera al día siguiente", actor: "agente", actorLabel: "Argos · agente" },
  { id: "puede", kind: "decision", label: "¿Puede escribirle Sofi?" },
  { id: "escribe", kind: "paso", label: "Le escribe", actor: "agente", actorLabel: "Sofi · agente" },
  { id: "fin", kind: "fin", label: "Lo resuelve Sofi" },
]

const notice: FlowDiagramStep = {
  id: "aviso",
  kind: "paso",
  label: "Avisa por qué y cómo habilitarlo",
  actor: "agente",
  actorLabel: "Argos · siempre",
}

const withTask: FlowDiagramStep[] = [
  notice,
  { id: "tarea", kind: "paso", label: "Tarea de llamada", actor: "persona", actorLabel: "Equipo de recepción · persona" },
  { id: "fin-persona", kind: "fin", label: "Le toca a una persona" },
]

export const AgenteConRespaldo: Story = {
  render: () => <FlowDiagram label="Reprogramar tras una inasistencia" main={main} otherwise={withTask} />,
}

export const AgenteSoloConAviso: Story = {
  render: () => (
    <FlowDiagram
      label="Reprogramar tras una inasistencia"
      main={main}
      otherwise={[notice, { id: "fin-aviso", kind: "fin", label: "Queda avisado" }]}
    />
  ),
}

export const SoloUnaPersona: Story = {
  render: () => (
    <FlowDiagram
      label="Saldo vencido"
      main={[
        { id: "inicio", kind: "inicio", label: "Un saldo pasa 30 días vencido" },
        { id: "espera", kind: "paso", label: "Espera 30 días", actor: "agente", actorLabel: "Argos · agente" },
        { id: "tarea", kind: "paso", label: "Tarea de cobro", actor: "persona", actorLabel: "Caja · persona" },
        { id: "fin", kind: "fin", label: "Le toca a una persona" },
      ]}
    />
  ),
}

/** Apagada: el flujo completo, atenuado y sin movimiento. */
export const Detenido: Story = {
  render: () => <FlowDiagram label="Reprogramar tras una inasistencia" main={main} otherwise={withTask} idle />,
}

export const Estrecho: Story = {
  render: () => (
    <div className="max-w-sm">
      <FlowDiagram label="Reprogramar tras una inasistencia" main={main} otherwise={withTask} />
    </div>
  ),
}
