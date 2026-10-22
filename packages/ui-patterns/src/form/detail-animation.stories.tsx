import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { Plus } from "lucide-react"
import { useState } from "react"
import { MasterDetail } from "../master-detail.js"
import { PageHeader } from "../page-header.js"
import { DemoFields, DemoTable, demoSubmit } from "../story-fixtures.js"
import { FormPanel } from "./form-panel.js"

/**
 * Entrada y salida del detalle lateral con el componente real: `MasterDetail`
 * abre la columna y desliza el formulario en los mismos 450ms y con la misma
 * curva que el popup del drawer, y al cerrar hace las dos cosas a la vez.
 *
 * Se abre con el botón de la cabecera y se cierra con el Cancelar del propio
 * `FormPanel`, las dos vías de producción. El modo panel solo existe desde
 * 1280px de ancho: por debajo, `MasterDetail` no monta el detalle (la página
 * montaría un `FormDrawer`), así que hay que ver la story en el viewport ancho.
 *
 * Nota: la barra de filtros es una maqueta con las clases exactas del root de
 * `FilterBar` (`flex p-3 bg-card rounded-md`): el componente real exige el router
 * de TanStack y no monta en Storybook.
 */
const meta = {
  title: "Patrones/MasterDetail/Animación",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const EntradaYSalida: Story = {
  render: function AnimatedStory() {
    const [open, setOpen] = useState(false)

    return (
      <div className="bg-muted min-h-svh w-full p-6">
        <MasterDetail
          panel={
            open ? (
              <FormPanel
                title="Editar Sede Miraflores"
                description="La fila en edición queda marcada en la tabla."
                onClose={() => setOpen(false)}
                onSubmit={demoSubmit}
              >
                <DemoFields />
              </FormPanel>
            ) : null
          }
        >
          <PageHeader
            title="Sucursales"
            subtitle="Clínica Odontológica Sur"
            primary={{
              label: "Nueva sucursal",
              icon: <Plus className="size-4" />,
              disabled: open,
              onClick: () => setOpen(true),
            }}
          />
          <div className="flex p-3 bg-card rounded-md">
            <div className="flex min-w-0 flex-1 items-center gap-2 p-1">
              <span className="text-sm text-muted-foreground">Buscar sucursal</span>
              <span className="ml-auto shrink-0 text-sm text-muted-foreground">Estado: Todas</span>
            </div>
          </div>
          <DemoTable activeId={open ? "1" : undefined} />
        </MasterDetail>
      </div>
    )
  },
}
