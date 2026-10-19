import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useState } from "react"
import { DataTable } from "./data-table.js"
import { ExpandableText } from "./expandable-text.js"

const meta = { title: "Patrones/Texto ampliable", component: ExpandableText, parameters: { layout: "padded" } } satisfies Meta<typeof ExpandableText>
export default meta
type Story = StoryObj<typeof meta>
export const Largo: Story = { args: { text: "Valeria completó el registro de Thiago. Falta confirmar su relación y quién lo acompañará. Preguntó si podía llevarlo después del colegio y qué documentación debía presentar. La cita todavía no está confirmada. Registra la respuesta en la misma conversación para conservar el contexto.", label: "contexto de la tarea" }, decorators: [(Story) => <div className="max-w-xs"><Story /></div>] }
export const Corto: Story = { args: { text: "Confirmar la cita." } }

function ListExample() {
  const [opened, setOpened] = useState("")
  const table = useReactTable({
    data: [{ id: "1", title: "Confirmar quién acompaña a Thiago a su primera cita y qué documentos debe presentar Valeria antes de reservar la evaluación", reason: String(Largo.args?.text), person: "Thiago Quispe" }, { id: "2", title: "Llamar a Rosa", reason: "Confirmar la hora.", person: "Rosa Quispe" }],
    columns: [
      { id: "title", header: "Tarea", meta: { view: { role: "title" } }, cell: ({ row }) => <div className="max-w-sm space-y-1"><ExpandableText text={row.original.title} label="título" className="font-medium" /><ExpandableText text={row.original.reason} label="contexto" className="text-muted-foreground" /></div> },
      { accessorKey: "person", header: "De quién", meta: { view: { primary: true } } },
      { id: "due", header: "Vence", meta: { view: { primary: true } }, cell: () => "Hoy, 16:00" },
      { id: "actions", header: "", meta: { view: { role: "actions" } }, cell: ({ row }) => <Button variant="outline" onClick={() => setOpened(row.original.id)}>Abrir tarea</Button> },
    ],
    getCoreRowModel: getCoreRowModel(),
  })
  return <><DataTable table={table} onRowClick={(row) => setOpened(row.id)} /><p role="status">{opened ? `Abierta la tarea ${opened}` : "Ampliar no abre la tarea"}</p></>
}
export const EnLista: Story = { render: () => <ListExample />, args: { text: "" } }
