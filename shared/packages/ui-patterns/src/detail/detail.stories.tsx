import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { MasterDetail, useDetailMode } from "../master-detail.js"
import {
  DemoDetailActions,
  DemoDetailBody,
  DemoPage,
  DemoStage,
  DemoTable,
} from "../story-fixtures.js"
import { Detail } from "./detail.js"
import { DetailDrawer } from "./detail-drawer.js"
import { DetailPanel } from "./detail-panel.js"

/**
 * Detalle de lectura con un solo contenido y dos contenedores: tarjeta lateral
 * en pantalla ancha y drawer modal por debajo del corte de 1280px. Usa la
 * toolbar de viewport de Storybook para cruzar el corte en las dos stories.
 *
 * La primera story usa `Detail`, que elige el contenedor solo. La segunda es la
 * receta dentro de `MasterDetail`: ahí la columna se controla pasando `null`
 * como `panel`, así que la página decide el modo y monta **uno solo** de los dos
 * contenedores (los dos a la vez duplicarían los `id` del contenido).
 */
const meta = {
  title: "Patrones/Detalle",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const DETAIL_TITLE = "Atención del 12/09/2026"
const DETAIL_DESCRIPTION = "Resumen de la atención: lo registrado queda inmutable."

export const ModoSuelto: Story = {
  render: function AutoStory() {
    const [open, setOpen] = useState(true)

    return (
      <DemoStage className="max-w-md">
        <Detail
          open={open}
          title={DETAIL_TITLE}
          description={DETAIL_DESCRIPTION}
          actions={<DemoDetailActions />}
          onClose={() => setOpen(false)}
        >
          <DemoDetailBody />
        </Detail>
      </DemoStage>
    )
  },
}

export const EnLista: Story = {
  render: function InListStory() {
    const mode = useDetailMode()
    const [open, setOpen] = useState(true)
    // Un solo objeto de props: el mismo contenido entra en los dos contenedores
    // sin repetir campos, ids ni acciones.
    const shell = {
      title: DETAIL_TITLE,
      description: DETAIL_DESCRIPTION,
      actions: <DemoDetailActions />,
      children: <DemoDetailBody />,
      onClose: () => setOpen(false),
    }

    return (
      <DemoPage>
        <div className="flex flex-col gap-4">
          {open ? null : <Button onClick={() => setOpen(true)}>Ver atención</Button>}
          <MasterDetail panel={mode === "panel" && open ? <DetailPanel {...shell} /> : null}>
            <DemoTable activeId={open ? "1" : undefined} />
          </MasterDetail>
        </div>
        {mode !== "panel" && open ? <DetailDrawer open {...shell} /> : null}
      </DemoPage>
    )
  },
}