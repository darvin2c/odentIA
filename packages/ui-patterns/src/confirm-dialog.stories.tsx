import { Field, FieldLabel, Textarea } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { ConfirmDialog } from "./confirm-dialog.js"

/**
 * Confirmación de acciones terminales. Cuando el contrato exige un motivo
 * (anular un diagnóstico, un procedimiento o la atención), el motivo va dentro
 * del diálogo y la confirmación queda bloqueada hasta completarlo.
 */
const meta = {
  title: "Patrones/ConfirmDialog",
  parameters: { layout: "centered" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Simple: Story = {
  render: () => (
    <ConfirmDialog
      open
      title="Archivar especialidad"
      description="Deja de ofrecerse en formularios nuevos; lo registrado se conserva."
      confirmLabel="Archivar"
      variant="default"
      onConfirm={() => {}}
      onClose={() => {}}
    />
  ),
}

function WithReason() {
  const [reason, setReason] = useState("")
  return (
    <ConfirmDialog
      open
      title="Anular este borrador"
      description="Queda como «anulada» con tu nombre, la hora y el motivo. No genera cargos."
      confirmLabel="Anular borrador"
      confirmDisabled={!reason.trim()}
      onConfirm={() => {}}
      onClose={() => {}}
    >
      <Field>
        <FieldLabel htmlFor="story-reason">Motivo</FieldLabel>
        <Textarea
          id="story-reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  )
}

export const ConMotivo: Story = { render: () => <WithReason /> }

export const Guardando: Story = {
  render: () => (
    <ConfirmDialog
      open
      title="Anular diagnóstico"
      description="K02.1 · 36 Oclusal. Queda en la historia como anulado."
      confirmLabel="Anular diagnóstico"
      pending
      onConfirm={() => {}}
      onClose={() => {}}
    />
  ),
}
