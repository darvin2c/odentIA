import type { Meta, StoryObj } from "@storybook/react"
import type { ReactNode } from "react"
import { FormPanel } from "./form/form-panel.js"
import { type DetailPanelSize, MasterDetail } from "./master-detail.js"
import { DemoFields, DemoTable, demoSubmit, useDemoWizard } from "./story-fixtures.js"

/**
 * Lista maestra + detalle lateral. El modo efectivo depende del ancho del
 * viewport (corte en 1280px): usa la toolbar de viewport de Storybook para ver
 * el fallback a drawer por debajo del corte.
 */
const meta = {
  title: "Patrones/MasterDetail",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

function DetailStage({
  panel,
  panelSize,
  activeId,
}: {
  panel: ReactNode | null
  panelSize?: DetailPanelSize
  activeId?: string
}) {
  return (
    <div className="bg-muted min-h-svh w-full p-6">
      <MasterDetail panel={panel} panelSize={panelSize}>
        <DemoTable activeId={activeId} />
      </MasterDetail>
    </div>
  )
}

export const Cerrado: Story = {
  render: () => <DetailStage panel={null} />,
}

export const PanelMd: Story = {
  render: () => (
    <DetailStage
      activeId="1"
      panel={
        <FormPanel
          title="Editar Sede Miraflores"
          description="La fila en edición queda marcada en la tabla."
          onClose={noop}
          onSubmit={demoSubmit}
        >
          <DemoFields />
        </FormPanel>
      }
    />
  ),
}

export const PanelLgDosColumnas: Story = {
  render: () => (
    <DetailStage
      panelSize="lg"
      panel={
        <FormPanel title="Registrar antecedentes" onClose={noop} onSubmit={demoSubmit}>
          <DemoFields wide />
        </FormPanel>
      }
    />
  ),
}

export const PanelXlWizard: Story = {
  render: function WizardStory() {
    const wizard = useDemoWizard()
    return (
      <DetailStage
        panelSize="xl"
        panel={
          <FormPanel
            title="Nueva atención"
            headerContent={wizard.headerContent}
            submitLabel={wizard.submitLabel}
            onSubmit={wizard.onSubmit}
            onClose={noop}
          >
            {wizard.body}
          </FormPanel>
        }
      />
    )
  },
}
