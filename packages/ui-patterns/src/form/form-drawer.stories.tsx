import { toast } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { DemoFields, demoSubmit, useDemoWizard } from "../story-fixtures.js"
import { FormDrawer } from "./form-drawer.js"

/**
 * El mismo shell que `FormPanel` pero en drawer modal: overlay, focus-trap y
 * Esc los aporta Base UI. Las stories de ancho replican el hack de
 * `--drawer-content-width` que usan hoy las páginas con formularios extensos.
 *
 * El feedback de guardado es por toast (éxito y error), como en el platform.
 */
const meta = {
  title: "Patrones/FormDrawer",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Compacto: Story = {
  render: () => (
    <FormDrawer open title="Editar sucursal" onClose={noop} onSubmit={demoSubmit}>
      <DemoFields />
    </FormDrawer>
  ),
}

export const Ancho48rem: Story = {
  render: () => (
    <FormDrawer
      open
      title="Registrar antecedentes"
      description="Drawer ensanchado vía CSS var, como imagenes-tab y document-upload."
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
      onClose={noop}
      onSubmit={demoSubmit}
    >
      <DemoFields wide />
    </FormDrawer>
  ),
}

export const Wizard: Story = {
  render: function WizardStory() {
    const wizard = useDemoWizard()
    return (
      <FormDrawer
        open
        title="Nueva atención"
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
        headerContent={wizard.headerContent}
        submitLabel={wizard.submitLabel}
        onSubmit={wizard.onSubmit}
        onClose={noop}
      >
        {wizard.body}
      </FormDrawer>
    )
  },
}

export const FalloDeGuardado: Story = {
  render: function FailingStory() {
    const [error, setError] = useState<string | null>(null)
    return (
      <FormDrawer
        open
        title="Editar sucursal"
        error={error}
        onClose={noop}
        onSubmit={(event) => {
          event.preventDefault()
          setError("No se pudo guardar: la sesión expiró.")
          toast.error("No se pudo guardar. Inténtalo de nuevo.")
        }}
      >
        <DemoFields />
      </FormDrawer>
    )
  },
}
