import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { RadioChips } from "./radio-chips.js"

/**
 * Pocas opciones excluyentes como pastillas: el grupo de radios de WAI-ARIA. Una sola parada de
 * Tab (la elegida o la primera), flechas que mueven y eligen, Espacio que elige; Enter no marca.
 * Con el teclado, la pastilla con foco lleva el anillo de los botones, distinto de «elegida»
 * (borde y fondo). Recorre las historias con Tab y las flechas para verlo.
 */
const meta = {
  title: "Patrones/RadioChips",
  parameters: { layout: "padded" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const YES_NO = [
  { value: "si", label: "Sí" },
  { value: "no", label: "No" },
]

function YesNo({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial)
  return (
    <div className="flex flex-col gap-2">
      <p id="story-pain" className="text-sm font-medium">
        ¿Tienes dolor ahora?
      </p>
      <RadioChips aria-labelledby="story-pain" value={value} options={YES_NO} onChange={setValue} />
    </div>
  )
}

/** Sí/No: las flechas dan la vuelta, como en cualquier grupo de radios. */
export const SiNo: Story = { render: () => <YesNo /> }

/** Con una respuesta elegida: con foco se ve el anillo; sin foco, solo el borde y el fondo. */
export const Elegida: Story = { render: () => <YesNo initial="si" /> }

/** Marcada como inválida (falta responder): el error lo dice su campo, fuera del grupo. */
export const SinResponder: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <p id="story-invalid" className="text-sm font-medium">
        ¿Tienes dolor ahora?
      </p>
      <RadioChips aria-labelledby="story-invalid" value={null} options={YES_NO} onChange={() => {}} invalid />
    </div>
  ),
}

/** Apagada: un formulario finalizado que solo se lee. */
export const Apagada: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <p id="story-disabled" className="text-sm font-medium">
        ¿Tienes dolor ahora?
      </p>
      <RadioChips aria-labelledby="story-disabled" value="no" options={YES_NO} onChange={() => {}} disabled />
    </div>
  ),
}
