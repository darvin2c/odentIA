import type { Meta, StoryObj } from "@storybook/react"
import { DEMO_DETAIL_MENU_ITEMS, DemoDetailActions, DemoDetailBody } from "../story-fixtures.js"
import { RowActions } from "../row-actions.js"
import { DetailDrawer } from "./detail-drawer.js"

/**
 * El mismo detalle en drawer modal: overlay, focus-trap, Esc y swipe los aporta
 * Base UI (en móvil baja desde abajo con asa). `size` mantiene el ancho del
 * panel de referencia para que el detalle no cambie de tamaño al cruzar el
 * corte de 1280px.
 */
const meta = {
  title: "Patrones/Detalle/Drawer",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Compacto: Story = {
  render: () => (
    <DetailDrawer
      open
      title="Atención del 12/09/2026"
      description="Drawer md: 24rem, el mismo ancho que el panel md."
      actions={<DemoDetailActions />}
      onClose={noop}
    >
      <DemoDetailBody />
    </DetailDrawer>
  ),
}

export const AnchoLg: Story = {
  render: () => (
    <DetailDrawer
      open
      size="lg"
      title="Atención del 12/09/2026"
      description="Drawer lg: 32rem, el ancho del panel lg."
      actions={<DemoDetailActions />}
      onClose={noop}
    >
      <DemoDetailBody />
    </DetailDrawer>
  ),
}

export const AnchoXl: Story = {
  render: () => (
    <DetailDrawer
      open
      size="xl"
      title="Atención del 12/09/2026"
      description="Drawer xl: 40rem. Los campos se reparten en dos columnas por el ancho real del drawer."
      actions={<DemoDetailActions />}
      onClose={noop}
    >
      <DemoDetailBody />
    </DetailDrawer>
  ),
}

export const Cargando: Story = {
  render: () => (
    <DetailDrawer open title="Atención del 12/09/2026" isLoading onClose={noop}>
      <DemoDetailBody />
    </DetailDrawer>
  ),
}

export const AccionesEnMenu: Story = {
  render: () => (
    <DetailDrawer
      open
      size="lg"
      title="Atención del 12/09/2026"
      description="El pie acepta un menú en vez de botones, sin props nuevas."
      actions={<RowActions label="Acciones de la atención" items={DEMO_DETAIL_MENU_ITEMS} />}
      onClose={noop}
    >
      <DemoDetailBody />
    </DetailDrawer>
  ),
}