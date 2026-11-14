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
const SCALE = Array.from({ length: 11 }, (_, n) => ({ value: String(n), label: String(n) }))

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

function Scale() {
  const [value, setValue] = useState<string | null>("0")
  return (
    <div className="flex max-w-md flex-col gap-2">
      <p id="story-scale" className="text-sm font-medium">
        ¿Cuánto te duele? (0 a 10)
      </p>
      <RadioChips
        aria-labelledby="story-scale"
        value={value}
        options={SCALE}
        onChange={setValue}
        onClear={() => setValue(null)}
        ordered
      />
    </div>
  )
}

/**
 * Una escala (`ordered`): las flechas se detienen en 0 y en 10 (← en 0 no marca 10), e Inicio y
 * Fin van a los extremos. Lo opcional se deja sin responder con «Quitar respuesta».
 */
export const Escala: Story = { render: () => <Scale /> }

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
