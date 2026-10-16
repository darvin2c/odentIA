import type { Meta, StoryObj } from "@storybook/react"
import { UsageMeter } from "./usage-meter.js"

/**
 * Medidor de consumo de Plan y pagos: el crédito del mes, el saldo de la
 * prueba y el tope de gasto. Cada nivel también se dice en palabras; verlo en
 * tema oscuro y en ancho de teléfono.
 */
const meta = {
  title: "Patrones/UsageMeter",
  component: UsageMeter,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="max-w-md">{Story()}</div>],
} satisfies Meta<typeof UsageMeter>

export default meta
type Story = StoryObj<typeof meta>

export const Normal: Story = {
  args: {
    label: "Saldo de prueba",
    value: 1700,
    total: 5000,
    valueText: "USD 17 de USD 50",
    description: "Te quedan 12 días de prueba.",
  },
}

export const Aviso: Story = {
  args: {
    label: "Tope por encima del crédito",
    value: 75_000,
    total: 100_000,
    valueText: "USD 750 de USD 1.000",
    description: "Al llegar, Recepción pasa los casos nuevos a tu equipo con un mensaje fijo.",
  },
}

export const Alarma: Story = {
  args: {
    label: "Saldo de prueba",
    value: 4_600,
    total: 5_000,
    valueText: "USD 46 de USD 50",
    description: "A este ritmo se acaba el jueves 23. Cuando se acabe, los agentes se pausan.",
  },
}

export const Completo: Story = {
  args: {
    label: "Crédito del mes",
    value: 2_900,
    total: 2_900,
    valueText: "USD 29 de USD 29",
    description: "Se acabó el día 2: desde entonces cada acción se cobra con tu precio y los agentes siguen atendiendo.",
  },
}
