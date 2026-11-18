import type { Meta, StoryObj } from "@storybook/react"
import { PageShell } from "../page-shell.js"
import { BarList } from "./index.js"

/**
 * Barras horizontales de Reportes: el embudo de Pacientes y los repartos con
 * nombres largos. Cada barra es un control: las flechas recorren las filas,
 * pasar el mouse o enfocar una la destaca y, si abre algo, Enter lo abre.
 */
const meta = {
  title: "Patrones/Gráficos de datos/Barras horizontales",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const STEPS = [
  { key: "sought", label: "Nos buscaron", hint: "Primera conversación o registro", value: 96, note: undefined },
  { key: "booked", label: "Agendaron", hint: "= «Evaluación agendada» en Oportunidades", value: 52, note: "54 % · agosto 50 %" },
  { key: "came", label: "Vinieron", hint: "Su primera cita, atendida", value: 41, note: "79 % · agosto 81 %" },
  { key: "budget", label: "Recibieron presupuesto", hint: "= «Presupuesto enviado»", value: 27, note: "66 % · agosto 63 %" },
  { key: "accepted", label: "Aceptaron", hint: "= «Ganada» en Oportunidades", value: 16, note: "59 % · agosto 55 %" },
  { key: "paid", label: "Pagaron algo", hint: "Al menos un pago", value: 14, note: "88 % · agosto 90 %" },
]

/** El embudo: las mismas personas paso a paso, con quiénes se caen entre uno y otro. */
export const Embudo: Story = {
  render: () => (
    <PageShell className="flex flex-col gap-4">
      <div className="elevated flex max-w-4xl flex-col gap-3 rounded-xl border bg-card p-5">
        <strong>Dónde se caen los pacientes</strong>
        <BarList
          title="Embudo de septiembre"
          rows={STEPS.map((step) => ({ ...step, valueText: String(step.value), attention: step.key === "booked" }))}
          onSelect={() => undefined}
          selectLabel="Ver quiénes"
          between={(index) =>
            index === 0 ? (
              <p className="ml-1.5 rounded-lg bg-warning-soft px-3 py-1.5 text-[13px] font-bold text-warning">Aquí se caen más: 44 no agendaron</p>
            ) : index < STEPS.length - 1 ? (
              <p className="ml-3 py-0.5 text-[13px] text-muted-foreground">↓ {(STEPS[index]?.value ?? 0) - (STEPS[index + 1]?.value ?? 0)} no siguieron</p>
            ) : null
          }
          table={{ label: "Paso", value: "Personas", note: "Del paso anterior" }}
        />
      </div>
    </PageShell>
  ),
}

/** Un reparto con su parte: por dónde nos buscaron y, más oscuro, quiénes vinieron. */
export const ConParte: Story = {
  render: () => (
    <PageShell className="flex flex-col gap-4">
      <div className="elevated flex max-w-2xl flex-col gap-3 rounded-xl border bg-card p-5">
        <strong>Por dónde nos buscaron</strong>
        <BarList
          title="Canal de la primera conversación y quiénes vinieron"
          size="sm"
          legend={{ value: "Nos buscaron", part: "Vinieron" }}
          rows={[
            { key: "whatsapp", label: "WhatsApp", value: 52, part: 23, valueText: "23 de 52", note: "44 %" },
            { key: "recepcion", label: "Recepción", value: 21, part: 11, valueText: "11 de 21", note: "52 %" },
            { key: "instagram", label: "Instagram", value: 14, part: 4, valueText: "4 de 14", note: "29 %" },
            { key: "webchat", label: "Chat web", value: 9, part: 3, valueText: "3 de 9", note: "33 %" },
          ]}
          table={{ label: "Canal", value: "Vinieron de los que buscaron", note: "Vinieron" }}
        />
      </div>
      <div className="elevated flex max-w-md flex-col gap-3 rounded-xl border bg-card p-5">
        <strong>Cómo nos conocieron</strong>
        <BarList
          title="Cómo nos conocieron los pacientes nuevos"
          size="sm"
          rows={[
            { key: "recomendacion", label: "Recomendación", value: 14, valueText: "14" },
            { key: "redes", label: "Redes sociales", value: 9, valueText: "9" },
            { key: "google", label: "Google o mapas", value: 7, valueText: "7" },
            { key: "otro", label: "Otro", value: 3, valueText: "3", muted: true },
          ]}
          table={{ label: "Cómo nos conoció", value: "Pacientes nuevos" }}
        />
      </div>
    </PageShell>
  ),
}
