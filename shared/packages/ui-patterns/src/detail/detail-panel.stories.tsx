import { Button, toast } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import {
  DEMO_DETAIL_MENU_ITEMS,
  DemoDetailActions,
  DemoDetailBody,
  DemoStage,
} from "../story-fixtures.js"
import { RowActions } from "../row-actions.js"
import { DetailPanel } from "./detail-panel.js"

/**
 * Detalle en tarjeta lateral, no modal: la lista sigue visible mientras se
 * consulta. El ancho en producción lo aporta `MasterDetail` según `panelSize`;
 * aquí cada story fija el suyo para comparar el contenido en 24, 32 y 40rem.
 *
 * El cuerpo es un contenedor de consulta: `DetailList` pasa a dos columnas
 * cuando la tarjeta supera 32rem, no cuando lo hace el viewport.
 *
 * El pie acepta cualquier nodo: botones (las stories de arriba) o un menú de
 * acciones (las dos últimas), sin props nuevas. El menú es para acciones
 * secundarias; una acción terminal va como botón propio con confirmación.
 */
const meta = {
  title: "Patrones/Detalle/Panel",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Compacto: Story = {
  render: () => (
    <DemoStage className="max-w-sm">
      <DetailPanel
        title="Atención del 12/09/2026"
        description="Resumen de la atención."
        actions={<DemoDetailActions />}
        onClose={noop}
      >
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}

export const DosColumnas: Story = {
  render: () => (
    <DemoStage className="max-w-2xl">
      <DetailPanel
        title="Atención del 12/09/2026"
        description="Panel lg: los campos cortos se reparten en dos columnas."
        actions={<DemoDetailActions />}
        onClose={noop}
      >
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}

export const SoloLectura: Story = {
  render: () => (
    <DemoStage className="max-w-md">
      <DetailPanel
        title="Atención del 12/09/2026"
        description="Sin acciones ni botón de cierre: el pie no se monta."
        actions={null}
        showClose={false}
        onClose={noop}
      >
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}

export const Cargando: Story = {
  render: () => (
    <DemoStage className="max-w-md">
      <DetailPanel title="Atención del 12/09/2026" isLoading onClose={noop}>
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}

export const FalloDeCarga: Story = {
  render: () => (
    <DemoStage className="max-w-md">
      <DetailPanel
        title="Atención del 12/09/2026"
        error="No se pudo cargar el detalle: la atención ya no está disponible."
        actions={<DemoDetailActions />}
        onClose={noop}
      >
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}

export const AccionesEnMenu: Story = {
  render: () => (
    <DemoStage className="max-w-sm">
      <DetailPanel
        title="Atención del 12/09/2026"
        description="Cuatro acciones secundarias y ninguna primaria: menú ⋯ en el pie."
        actions={<RowActions label="Acciones de la atención" items={DEMO_DETAIL_MENU_ITEMS} />}
        onClose={noop}
      >
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}

export const PrimariaYMenu: Story = {
  render: () => (
    <DemoStage className="max-w-sm">
      <DetailPanel
        title="Atención del 12/09/2026"
        description="Una primaria visible (Editar) y el resto en el menú."
        actions={
          <>
            <RowActions label="Más acciones de la atención" items={DEMO_DETAIL_MENU_ITEMS} />
            <Button type="button" onClick={() => toast.info("Aquí se abriría la edición.")}>
              Editar
            </Button>
          </>
        }
        onClose={noop}
      >
        <DemoDetailBody />
      </DetailPanel>
    </DemoStage>
  ),
}