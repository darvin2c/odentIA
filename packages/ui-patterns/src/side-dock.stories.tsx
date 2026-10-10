import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { FormPanel } from "./form/form-panel.js"
import { MasterDetail } from "./master-detail.js"
import { SideDockProvider, SideDockSlot } from "./side-dock.js"
import { DemoFields, demoSubmit } from "./story-fixtures.js"

/**
 * Columna lateral del layout: el detalle de una lista se monta a todo el alto,
 * pegado al borde derecho, y se redimensiona desde su borde (arrastre, flechas,
 * doble clic). En ventanas de menos de 1280 px la página usa `FormDrawer`.
 */
const meta = {
  title: "Patrones/SideDock",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Demo({ size }: { size: "md" | "xl" }) {
  const [open, setOpen] = useState(true)
  return (
    <SideDockProvider>
      <div className="flex min-h-svh">
        <div className="flex min-w-0 flex-1 flex-col p-6">
          <MasterDetail
            panelSize={size}
            panel={
              open ? (
                <FormPanel
                  title="Editar sucursal"
                  description="El formulario ocupa todo el lado derecho."
                  onClose={() => setOpen(false)}
                  onSubmit={demoSubmit}
                >
                  <DemoFields />
                </FormPanel>
              ) : null
            }
          >
            <h1 className="text-2xl font-bold tracking-tight">Sucursales</h1>
            <p className="text-muted-foreground">
              La lista sigue usable mientras el formulario está abierto.
            </p>
            <div>
              <Button onClick={() => setOpen(true)} disabled={open}>
                Abrir formulario
              </Button>
            </div>
          </MasterDetail>
        </div>
        <SideDockSlot />
      </div>
    </SideDockProvider>
  )
}

export const FormularioCompacto: Story = { render: () => <Demo size="md" /> }

export const FormularioAncho: Story = { render: () => <Demo size="xl" /> }
