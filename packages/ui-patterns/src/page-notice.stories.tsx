import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { PageNotice } from "./page-notice.js"

/**
 * Los momentos del tablero C4 (cobro por acción, ADR 0030), de arriba abajo:
 * aviso, alarma y límite. Verlo en tema oscuro y en ancho de teléfono: la
 * acción baja de línea antes de recortar el texto.
 */
const meta = {
  title: "Patrones/PageNotice",
  component: PageNotice,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PageNotice>

export default meta
type Story = StoryObj<typeof meta>

const choose = (
  <Button size="sm" variant="outline">
    Elegir plan
  </Button>
)

export const Aviso: Story = {
  args: {
    tone: "aviso",
    label: "Aviso",
    children: "Te quedan USD 12,50 de tu saldo de prueba. Los agentes atendieron 140 conversaciones y ordenaron 60 consultas.",
    action: choose,
    onDismiss: () => {},
  },
}

export const Alarma: Story = {
  args: {
    tone: "alarma",
    label: "Alarma",
    children: "A este ritmo, tu saldo de prueba se acaba el jueves 23. Cuando se acabe, los agentes se pausan.",
    action: choose,
    onDismiss: () => {},
  },
}

export const EnPausa: Story = {
  args: {
    tone: "limite",
    label: "En pausa",
    children: "Los agentes están en pausa: se usó todo el saldo de prueba. Las conversaciones nuevas las ve tu equipo en la Bandeja.",
    action: choose,
  },
}

export const Tope: Story = {
  args: {
    tone: "alarma",
    label: "Alarma",
    children: "Los agentes llevan USD 900 de tu tope de USD 1.000 este mes.",
    action: (
      <Button size="sm" variant="outline">
        Cambiar tope
      </Button>
    ),
    onDismiss: () => {},
  },
}
