import { Badge } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import type { ReactNode } from "react"
import { DemoDetailBody } from "../story-fixtures.js"
import { DetailField, DetailList, DetailSection } from "./detail-rows.js"

/**
 * Primitivas de contenido del detalle. Miden por contenedor: las dos primeras
 * stories usan el mismo marcado dentro de una caja de 40rem y de 20rem, y el
 * reparto en columnas cambia solo. Ninguna consulta depende del viewport.
 */
const meta = {
  title: "Patrones/Detalle/Campos",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Caja con contenedor de consulta propio, como el cuerpo de `DetailSurface`. */
function Stage({ width, children }: { width: string; children: ReactNode }) {
  return (
    <div className="bg-muted min-h-svh w-full p-6">
      <div className={`@container ${width} rounded-sm bg-card p-4`}>{children}</div>
    </div>
  )
}

function Fields() {
  return (
    <DetailSection title="Datos de la atención">
      <DetailList>
        <DetailField label="Paciente">María Fernanda Quispe Rojas</DetailField>
        <DetailField label="Historia clínica">HC-000024</DetailField>
        <DetailField label="Odontólogo">Dra. Lucía Ramos</DetailField>
        <DetailField label="Estado">
          <Badge variant="success">Finalizada</Badge>
        </DetailField>
      </DetailList>
    </DetailSection>
  )
}

export const ContenedorAncho: Story = {
  render: () => (
    <Stage width="w-[40rem]">
      <Fields />
    </Stage>
  ),
}

export const ContenedorAngosto: Story = {
  render: () => (
    <Stage width="w-[20rem]">
      <Fields />
    </Stage>
  ),
}

export const SinDato: Story = {
  render: () => (
    <Stage width="w-[32rem]">
      <DetailSection title="Campos sin dato">
        <DetailList>
          <DetailField label="Control indicado" />
          <DetailField label="Nota de evolución" />
          <DetailField label="Grupo sanguíneo" />
          <DetailField label="Observaciones">Sin alergias declaradas.</DetailField>
        </DetailList>
      </DetailSection>
    </Stage>
  ),
}

export const ContenidoCompleto: Story = {
  render: () => (
    <Stage width="w-[32rem]">
      <DemoDetailBody />
    </Stage>
  ),
}