import { Checkbox } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { DataTable, DataTableSkeleton } from "./data-table.js"
import type { DataTableView } from "./data-table-view.js"
import {
  PATIENT_AVATAR_COLUMN as AVATAR_COLUMN,
  PATIENT_BASE_COLUMNS as BASE_COLUMNS,
  DEMO_PATIENTS,
  DemoPage,
  type DemoPatient,
} from "./story-fixtures.js"

/**
 * Las tres vistas de `DataTable` sobre las MISMAS columnas: `table` (default),
 * `list` y `card` solo cambian el layout; el contenido sale siempre de
 * `ColumnDef.cell`. El reparto lo decide `meta.view` de cada columna:
 *
 * - `role`: huecos de lista y card (`title`, `media`, `select`, `actions`; el
 *   resto son campos).
 * - `primary: true`: campos de la línea de resumen: en lista y en la cabecera
 *   de la card (que no los repite en la ficha de abajo).
 * - `tableOnly: true`: la columna desaparece en lista y card (aquí «Etiquetas»).
 * - `label`: etiqueta del par label/valor en card cuando `header` no es un
 *   string (aquí «Última atención», cuyo header es un icono + texto).
 *
 * El responsive no se pide por prop: por debajo de 768px `useResolvedView`
 * fuerza `list` aunque la página pida `table` o `card`; para verlo hay que
 * estrechar la ventana (Storybook va sin addon de viewport).
 */
const meta = {
  title: "Patrones/DataTable",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function useDemoTable(columns: ColumnDef<DemoPatient>[]) {
  return useReactTable({
    data: DEMO_PATIENTS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
}

function DemoStage({
  view,
  columns = BASE_COLUMNS,
}: {
  view?: DataTableView
  columns?: ColumnDef<DemoPatient>[]
}) {
  const table = useDemoTable(columns)
  return (
    <DemoPage>
      <DataTable table={table} view={view} />
    </DemoPage>
  )
}

/** Vista default: cabecera con todas las columnas visibles, incluida «Etiquetas». */
export const Tabla: Story = {
  render: () => <DemoStage view="table" />,
}

/** Lista: título, media (avatar), línea de resumen (`primary`) y acciones. */
export const Lista: Story = {
  render: () => <DemoStage view="list" columns={[AVATAR_COLUMN, ...BASE_COLUMNS]} />,
}

/**
 * Cards: ficha con identidad arriba (media, título y los campos `primary` como
 * línea de meta) y el resto de campos como pares label/valor, en dos columnas
 * cuando el ancho de la card lo permite (`@container`, no el viewport). El
 * hover es por elevación; la superficie no cambia de fondo.
 */
export const Card: Story = {
  render: () => <DemoStage view="card" columns={[AVATAR_COLUMN, ...BASE_COLUMNS]} />,
}

/**
 * Fila activa: `isRowActive` marca el registro abierto en el detalle. Un click
 * sobre un control interno (checkbox, RowActions) no dispara `onRowClick`.
 */
function ActiveRowStage({ view }: { view: DataTableView }) {
  const [editing, setEditing] = useState<string | null>(null)
  const table = useDemoTable(BASE_COLUMNS)
  return (
    <DemoPage>
      <DataTable
        table={table}
        view={view}
        isRowActive={(row) => row.id === editing}
        onRowClick={(row) => setEditing(row.id)}
      />
    </DemoPage>
  )
}

export const FilaActiva: Story = {
  render: () => <ActiveRowStage view="table" />,
}

export const FilaActivaEnLista: Story = {
  render: () => <ActiveRowStage view="list" />,
}

/**
 * Selección masiva: la columna `select` monta su checkbox en la cabecera de la
 * tabla y en la `SelectionBar` cuando la vista no tiene cabecera (lista y card).
 */
function SelectionStage({ view }: { view: DataTableView }) {
  const [checked, setChecked] = useState<string[]>([])

  const columns = useMemo<ColumnDef<DemoPatient>[]>(() => {
    const allChecked = checked.length === DEMO_PATIENTS.length
    return [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={allChecked}
            onCheckedChange={(value) =>
              setChecked(value === true ? DEMO_PATIENTS.map((row) => row.id) : [])
            }
            aria-label="Seleccionar todos los pacientes de esta página"
          />
        ),
        meta: { view: { role: "select" } },
        cell: ({ row }) => (
          <Checkbox
            checked={checked.includes(row.original.id)}
            onCheckedChange={() =>
              setChecked((prev) =>
                prev.includes(row.original.id)
                  ? prev.filter((id) => id !== row.original.id)
                  : [...prev, row.original.id],
              )
            }
            aria-label={`Seleccionar ${row.original.name}`}
          />
        ),
      },
      AVATAR_COLUMN,
      ...BASE_COLUMNS.filter((column) => column.id !== "tags"),
    ]
  }, [checked])

  const table = useDemoTable(columns)
  return (
    <DemoPage>
      <DataTable table={table} view={view} />
    </DemoPage>
  )
}

export const SeleccionEnTabla: Story = {
  render: () => <SelectionStage view="table" />,
}

export const SeleccionMasivaEnLista: Story = {
  render: () => <SelectionStage view="list" />,
}

/**
 * Cargando: el esqueleto reserva el hueco de la vista pedida en `view`, para
 * que el contenido real no salte al llegar. `columnCount` son columnas en
 * tabla y pares label/valor en card; en lista el resumen siempre es una línea.
 */
export const Cargando: Story = {
  render: () => (
    <DemoPage>
      <DataTableSkeleton columnCount={6} rowCount={6} />
    </DemoPage>
  ),
}

export const CargandoConPaginacion: Story = {
  render: () => (
    <DemoPage>
      <DataTableSkeleton columnCount={6} rowCount={4} showPagination />
    </DemoPage>
  ),
}

/** Cargando en lista: media, título, resumen y acciones, como en `Lista`. */
export const CargandoEnLista: Story = {
  render: () => (
    <DemoPage>
      <DataTableSkeleton view="list" rowCount={6} />
    </DemoPage>
  ),
}

/** Cargando en card: media, título, acciones y pares label/valor, con pie. */
export const CargandoEnCard: Story = {
  render: () => (
    <DemoPage>
      <DataTableSkeleton view="card" columnCount={4} rowCount={6} showPagination />
    </DemoPage>
  ),
}
