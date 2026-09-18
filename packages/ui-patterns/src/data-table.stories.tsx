import { Avatar, AvatarFallback, Badge, Checkbox, toast } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { CalendarDays } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { DataTable, DataTableSkeleton } from "./data-table.js"
import type { DataTableView } from "./data-table-view.js"
import { RowActions } from "./row-actions.js"

/**
 * Las tres vistas de `DataTable` sobre las MISMAS columnas: `table` (default),
 * `list` y `card` solo cambian el layout; el contenido sale siempre de
 * `ColumnDef.cell`. El reparto lo decide `meta.view` de cada columna:
 *
 * - `role`: huecos de lista y card (`title`, `media`, `select`, `actions`; el
 *   resto son campos).
 * - `primary: true`: campos de la línea de resumen de la lista.
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

interface DemoPatient {
  id: string
  patientNumber: number
  name: string
  docNumber: string | null
  age: number
  phone: string | null
  channels: Array<"whatsapp" | "telegram">
  lastVisit: string | null
  tags: string[]
  isActive: boolean
}

const DEMO_PATIENTS: DemoPatient[] = [
  {
    id: "1",
    patientNumber: 1042,
    name: "Ana Torres Quispe",
    docNumber: "45872103",
    age: 34,
    phone: "999 888 777",
    channels: ["whatsapp", "telegram"],
    lastVisit: "2026-09-12",
    tags: ["Ortodoncia"],
    isActive: true,
  },
  {
    id: "2",
    patientNumber: 1043,
    name: "Luis Ramírez Sosa",
    docNumber: "09213847",
    age: 41,
    phone: "987 654 321",
    channels: ["whatsapp"],
    lastVisit: "2026-08-30",
    tags: ["Endodoncia"],
    isActive: true,
  },
  {
    id: "3",
    patientNumber: 1051,
    name: "Rosa Medina Vargas",
    docNumber: null,
    age: 28,
    phone: null,
    channels: [],
    lastVisit: "2026-07-02",
    tags: ["Blanqueamiento"],
    isActive: true,
  },
  {
    id: "4",
    patientNumber: 1060,
    name: "Jorge Salazar Peña",
    docNumber: "72314509",
    age: 57,
    phone: "951 234 876",
    channels: ["telegram"],
    lastVisit: "2025-11-19",
    tags: [],
    isActive: false,
  },
  {
    id: "5",
    patientNumber: 1074,
    name: "Carla Núñez Ríos",
    docNumber: "44120983",
    age: 19,
    phone: "934 112 550",
    channels: ["whatsapp", "telegram"],
    lastVisit: "2026-09-16",
    tags: ["Ortodoncia", "Control"],
    isActive: true,
  },
  {
    id: "6",
    patientNumber: 1088,
    name: "Miguel Ángel Chávez",
    docNumber: "10873422",
    age: 66,
    phone: "962 447 019",
    channels: [],
    lastVisit: null,
    tags: ["Prótesis"],
    isActive: false,
  },
]

const dateFormatter = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
})

/** Etiqueta de historia clínica, con el mismo formato que el platform. */
function hcLabel(patientNumber: number): string {
  return `HC-${String(patientNumber).padStart(6, "0")}`
}

function initials(name: string): string {
  return name
    .split(" ")
    .filter((part) => part.length > 2)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
}

function ChannelBadges({ channels }: { channels: DemoPatient["channels"] }) {
  if (channels.length === 0) return <span className="text-muted-foreground">Sin canal</span>
  return (
    <span className="flex flex-wrap gap-1">
      {channels.map((channel) => (
        <Badge key={channel} variant="secondary">
          {channel === "whatsapp" ? "WhatsApp" : "Telegram"}
        </Badge>
      ))}
    </span>
  )
}

function patientActions(row: DemoPatient) {
  return (
    <RowActions
      label={`Acciones de ${row.name}`}
      items={[
        {
          key: "open",
          label: "Abrir ficha",
          onSelect: () => toast.success(`Ficha de ${row.name}`),
        },
        {
          key: "archive",
          label: row.isActive ? "Archivar" : "Reactivar",
          tone: row.isActive ? "danger" : undefined,
          onSelect: () =>
            toast.success(row.isActive ? "Paciente archivado" : "Paciente reactivado"),
        },
      ]}
    />
  )
}

const BASE_COLUMNS: ColumnDef<DemoPatient>[] = [
  {
    accessorKey: "patientNumber",
    id: "number",
    header: "HC",
    meta: { view: { primary: true } },
    cell: ({ row }) => hcLabel(row.original.patientNumber),
  },
  {
    accessorKey: "name",
    id: "name",
    header: "Nombre",
    meta: { view: { role: "title" } },
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: "docNumber",
    id: "document",
    header: "Documento",
    cell: ({ row }) =>
      row.original.docNumber ? (
        `DNI ${row.original.docNumber}`
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: "age",
    id: "age",
    header: "Edad",
    cell: ({ getValue }) => `${getValue<number>()} años`,
  },
  {
    accessorKey: "phone",
    id: "phone",
    header: "Teléfono",
    meta: { view: { primary: true } },
    cell: ({ row }) => row.original.phone || <span className="text-muted-foreground">—</span>,
  },
  {
    accessorKey: "channels",
    id: "channels",
    header: "Canales",
    cell: ({ row }) => <ChannelBadges channels={row.original.channels} />,
  },
  {
    accessorKey: "lastVisit",
    id: "lastVisit",
    // Header no textual: la card usa `meta.view.label` para el par label/valor.
    header: () => (
      <span className="inline-flex items-center gap-1">
        <CalendarDays aria-hidden />
        Última
      </span>
    ),
    meta: { view: { label: "Última atención" } },
    cell: ({ row }) =>
      row.original.lastVisit ? (
        // Fecha sin hora: `new Date("2026-09-12")` la lee como UTC y en es-PE
        // (UTC-5) la mostraría un día antes.
        dateFormatter.format(new Date(`${row.original.lastVisit}T00:00:00`))
      ) : (
        <span className="text-muted-foreground">Sin atenciones</span>
      ),
  },
  {
    accessorKey: "tags",
    id: "tags",
    header: "Etiquetas",
    // Columna densa: solo tiene sentido en la vista tabla.
    meta: { view: { tableOnly: true } },
    cell: ({ row }) =>
      row.original.tags.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {row.original.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: "isActive",
    id: "status",
    header: "Estado",
    cell: ({ row }) => (
      <Badge variant={row.original.isActive ? "success" : "secondary"}>
        {row.original.isActive ? "Activo" : "Inactivo"}
      </Badge>
    ),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => patientActions(row.original),
  },
]

// Columna de avatar: ocupa el hueco `media` de la lista (`ItemMedia variant="image"`).
const AVATAR_COLUMN: ColumnDef<DemoPatient> = {
  id: "avatar",
  header: "",
  meta: { view: { role: "media" } },
  cell: ({ row }) => (
    <Avatar>
      <AvatarFallback>{initials(row.original.name)}</AvatarFallback>
    </Avatar>
  ),
}

function useDemoTable(columns: ColumnDef<DemoPatient>[]) {
  return useReactTable({
    data: DEMO_PATIENTS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
}

/** Fondo de página, para que las filas `bg-card` se lean como en el platform. */
function Stage({ children }: { children: ReactNode }) {
  return <div className="bg-muted min-h-svh w-full p-6">{children}</div>
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
    <Stage>
      <DataTable table={table} view={view} />
    </Stage>
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

/** Cards: pares label/valor de todas las columnas de campo (sin «Etiquetas», `tableOnly`). */
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
    <Stage>
      <DataTable
        table={table}
        view={view}
        isRowActive={(row) => row.id === editing}
        onRowClick={(row) => setEditing(row.id)}
      />
    </Stage>
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
    <Stage>
      <DataTable table={table} view={view} />
    </Stage>
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
    <Stage>
      <DataTableSkeleton columnCount={6} rowCount={6} />
    </Stage>
  ),
}

export const CargandoConPaginacion: Story = {
  render: () => (
    <Stage>
      <DataTableSkeleton columnCount={6} rowCount={4} showPagination />
    </Stage>
  ),
}

/** Cargando en lista: media, título, resumen y acciones, como en `Lista`. */
export const CargandoEnLista: Story = {
  render: () => (
    <Stage>
      <DataTableSkeleton view="list" rowCount={6} />
    </Stage>
  ),
}

/** Cargando en card: media, título, acciones y pares label/valor, con pie. */
export const CargandoEnCard: Story = {
  render: () => (
    <Stage>
      <DataTableSkeleton view="card" columnCount={4} rowCount={6} showPagination />
    </Stage>
  ),
}
