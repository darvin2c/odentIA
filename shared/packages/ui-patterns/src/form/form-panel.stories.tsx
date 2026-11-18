import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { DemoFields, DemoStage, demoSubmit, useDemoWizard } from "../story-fixtures.js"
import { FormPanel } from "./form-panel.js"

/**
 * Formulario en tarjeta lateral (no modal). El ancho lo decide el contenedor:
 * en producción lo aporta `MasterDetail` según `panelSize`; aquí cada story
 * fija el suyo para comparar compacto, dos columnas y wizard.
 *
 * Guardar bien se confirma con un toast. Un error se dice en el formulario: el
 * de un campo junto a él (`useAppForm`) y lo demás junto a los botones.
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

/**
 * Con cambios sin guardar, Cancelar o Esc preguntan con la confirmación propia;
 * al continuar editando, el foco vuelve al campo o al botón desde el que se
 * pidió cerrar. Sin cambios, cierra directo.
 */
export const CambiosSinGuardar: Story = {
  render: function UnsavedStory() {
    const [open, setOpen] = useState(true)
    const [dirty, setDirty] = useState(false)
    return (
      <DemoStage className="max-w-md">
        {open ? (
          <FormPanel
            title="Editar sucursal"
            description="Escribe en un campo y luego intenta cerrar."
            isDirty={dirty}
            onClose={() => {
              setOpen(false)
              setDirty(false)
            }}
            onSubmit={demoSubmit}
          >
            <div onInput={() => setDirty(true)}>
              <DemoFields />
            </div>
          </FormPanel>
        ) : (
          <Button type="button" onClick={() => setOpen(true)}>
            Abrir formulario
          </Button>
        )}
      </DemoStage>
    )
  },
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
          }}
        >
          <DemoFields />
        </FormPanel>
      </DemoStage>
    )
  },
}
