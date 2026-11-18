import type { Meta, StoryObj } from "@storybook/react"
import { LoadingState, PagePending } from "./loading-state.js"

const meta: Meta<typeof LoadingState> = {
  title: "Patterns/LoadingState",
  component: LoadingState,
}
export default meta

type Story = StoryObj<typeof LoadingState>

/** Dentro de una tarjeta: unas líneas, sin otra tarjeta alrededor. */
export const Lines: Story = {
  render: () => (
    <div className="elevated w-96 rounded-xl border bg-card p-[18px]">
      <h3 className="mb-3 font-semibold">Por profesional</h3>
      <LoadingState />
    </div>
  ),
}
export const Indeterminate: Story = { args: { kind: "indeterminate", message: "Verificando tu sesión…" } }
/** Mientras llega el código de una pantalla al navegar. */
export const Page: Story = { render: () => <PagePending /> }
