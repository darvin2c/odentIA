import { toast } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { DemoFields, DemoStage, demoSubmit, useDemoWizard } from "../story-fixtures.js"
import { FormPanel } from "./form-panel.js"

/**
 * Formulario en tarjeta lateral (no modal). El ancho lo decide el contenedor:
 * en producción lo aporta `MasterDetail` según `panelSize`; aquí cada story
 * fija el suyo para comparar compacto, dos columnas y wizard.
 *
 * El feedback de guardado es por toast (éxito y error), como en el platform.
 */
const meta = {
  title: "Patrones/FormPanel",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Compacto: Story = {
  render: () => (
    <DemoStage className="max-w-sm">
      <FormPanel
        title="Editar sucursal"
        description="Cuatro campos, una columna."
        onClose={noop}
        onSubmit={demoSubmit}
      >
        <DemoFields />
      </FormPanel>
    </DemoStage>
  ),
}

export const DosColumnas: Story = {
  render: () => (
    <DemoStage className="max-w-3xl">
      <FormPanel
        title="Registrar antecedentes"
        description="Formulario ancho: campos en dos columnas."
        onClose={noop}
        onSubmit={demoSubmit}
      >
        <DemoFields wide />
      </FormPanel>
    </DemoStage>
  ),
}

export const Wizard: Story = {
  render: function WizardStory() {
    const wizard = useDemoWizard()
    return (
      <DemoStage className="max-w-2xl">
        <FormPanel
          title="Nueva atención"
          description="Asistente de tres pasos con revisión final."
          headerContent={wizard.headerContent}
          submitLabel={wizard.submitLabel}
          onSubmit={wizard.onSubmit}
          onClose={noop}
        >
          {wizard.body}
        </FormPanel>
      </DemoStage>
    )
  },
}

export const Cargando: Story = {
  render: () => (
    <DemoStage className="max-w-md">
      <FormPanel title="Editar sucursal" isLoading onClose={noop} onSubmit={demoSubmit}>
        <DemoFields />
      </FormPanel>
    </DemoStage>
  ),
}

export const FalloDeGuardado: Story = {
  render: function FailingStory() {
    const [error, setError] = useState<string | null>(null)
    return (
      <DemoStage className="max-w-md">
        <FormPanel
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
        </FormPanel>
      </DemoStage>
    )
  },
}
