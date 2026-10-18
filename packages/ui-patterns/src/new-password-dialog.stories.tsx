import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { NewPasswordDialog } from "./new-password-dialog.js"
import { PasswordInput } from "./password-input.js"

const meta = {
  title: "Acceso/Contraseña nueva",
  component: NewPasswordDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NewPasswordDialog>
export default meta
type Story = StoryObj<typeof meta>

/** Después de entrar con el enlace: no se cierra sin guardar. */
export const ConContraseñaAnterior: Story = {
  args: { open: true, hasPassword: true, onSave: async () => null },
}

/** Quien entra solo con Google puede seguir sin contraseña. */
export const SoloGoogle: Story = {
  args: { open: true, hasPassword: false, onSave: async () => null, onSkip: async () => {} },
}

/** El servidor la rechaza: el mensaje queda bajo el campo. */
export const Rechazada: Story = {
  args: {
    open: true,
    hasPassword: true,
    onSave: async () => "Esta contraseña aparece en filtraciones conocidas. Elige otra.",
  },
}

/** El campo solo, con «Ver» y los requisitos a la vista. */
export const Campo: Story = {
  args: { open: false, hasPassword: true, onSave: async () => null },
  render: () => {
    const [value, setValue] = useState("sonrisa-miraflores")
    return (
      <div className="max-w-sm p-6">
        <PasswordInput
          id="nueva"
          value={value}
          onChange={setValue}
          autoComplete="new-password"
          requirements={[
            { label: "Al menos 8 caracteres", met: value.length >= 8 },
            { label: "No aparece en filtraciones conocidas", met: true },
          ]}
        />
      </div>
    )
  },
}
