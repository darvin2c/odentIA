import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { ViewTabs, type ViewTabsProps } from "./view-tabs.js"

/**
 * Elegir una vista de la lista (Pacientes, Tareas, Compras). Lo que espera a una
 * persona lleva su número después del nombre. Verlo en ancho de teléfono: la
 * franja se desplaza sin recortar la vista activa.
 */
const meta = {
  title: "Patrones/ViewTabs",
  component: ViewTabs,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ViewTabs>

export default meta
type Story = StoryObj<typeof meta>

/** Guarda la vista elegida, para que la historia muestre el cambio al tocar. */
function Live(props: ViewTabsProps<string>) {
  const [value, setValue] = useState(props.value)
  return <ViewTabs {...props} value={value} onValueChange={setValue} />
}

export const Vistas: Story = {
  args: {
    label: "Qué personas ver",
    value: "pacientes",
    onValueChange: () => {},
    options: [
      { value: "pacientes", label: "Pacientes" },
      { value: "por_registrar", label: "Contactos nuevos", count: 897 },
      { value: "archivados", label: "Archivados" },
      { value: "todos", label: "Todos" },
    ],
  },
  render: (args) => <Live {...args} />,
}

export const ConConteoYDeshabilitada: Story = {
  args: {
    label: "De qué agente",
    value: "todos",
    onValueChange: () => {},
    options: [
      { value: "todos", label: "Todos los agentes" },
      { value: "sofi", label: "Sofi", count: 1 },
      { value: "clio", label: "Clío", disabled: true },
      { value: "argos", label: "Argos · apagado", count: 3 },
    ],
  },
}

/**
 * Las seis vistas de la Bandeja en un teléfono: el borde se desvanece y la
 * flecha «›» anuncia que hay más; tocarla avanza la franja.
 */
export const NoCaben: Story = {
  args: {
    label: "Vista de la bandeja",
    value: "atender",
    onValueChange: () => {},
    options: [
      { value: "atender", label: "Por atender", count: 5 },
      { value: "sofi", label: "Las atiende Sofi", count: 1 },
      { value: "esperan", label: "Esperan al paciente", count: 2 },
      { value: "todas", label: "Todas" },
      { value: "spam", label: "Spam", count: 3 },
      { value: "bloqueados", label: "Bloqueados" },
    ],
  },
  render: (args) => (
    <div className="max-w-[343px]">
      <Live {...args} />
    </div>
  ),
}
