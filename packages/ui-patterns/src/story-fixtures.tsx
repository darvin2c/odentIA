import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  cn,
  Field,
  FieldLabel,
  Input,
  Textarea,
  toast,
} from "@odentia/ui"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { CalendarDays } from "lucide-react"
import { type FormEvent, type ReactNode, useMemo, useState } from "react"
import { DataTable } from "./data-table.js"
import { type WizardStep, WizardSteps } from "./form/wizard-steps.js"
import { RowActions } from "./row-actions.js"

/**
 * Fixtures compartidas por las stories: formularios de distintos anchos, un
 * wizard de tres pasos y una tabla de demostración. Viven fuera del barrel:
 * son material de Storybook, no API del paquete.
 */

export const WIZARD_STEPS: readonly WizardStep[] = [
  { id: "datos", label: "Datos" },
  { id: "detalle", label: "Detalle" },
  { id: "revision", label: "Revisión" },
]

const FIELD_LABELS = [
  "Nombre",
  "Apellido",
  "Correo",
  "Teléfono",
  "Documento",
  "Fecha de nacimiento",
]

/** Submit de demo: éxito por toast, el mismo feedback real del platform. */
export function demoSubmit(event: FormEvent) {
  event.preventDefault()
  toast.success("Cambios guardados")
}

/** Formulario de demostración; `wide` reparte los campos en dos columnas. */
export function DemoFields({ wide = false }: { wide?: boolean }) {
  return (
    <div className={cn(wide ? "grid gap-4 sm:grid-cols-2" : "flex flex-col gap-4")}>
      {FIELD_LABELS.map((label, index) => (
        <Field key={label}>
          <FieldLabel htmlFor={`demo-field-${index}`}>{label}</FieldLabel>
          <Input id={`demo-field-${index}`} />
        </Field>
      ))}
      <Field className={wide ? "sm:col-span-2" : undefined}>
        <FieldLabel htmlFor="demo-notes">Notas</FieldLabel>
        <Textarea id="demo-notes" rows={3} />
      </Field>
    </div>
  )
}

function DemoReview() {
  const entries: Array<[string, string]> = [
    ["Nombre", "Ana Torres"],
    ["Apellido", "Quispe"],
    ["Correo", "ana@odentia.dev"],
    ["Teléfono", "999 888 777"],
  ]
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {entries.map(([label, value]) => (
        <div key={label} className="rounded-md bg-surface px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Estado de un wizard de tres pasos: el paso intermedio usa el formulario
 * ancho y el final una revisión, como los asistentes reales del platform.
 */
export function useDemoWizard() {
  const [step, setStep] = useState(0)
  const [visited, setVisited] = useState<readonly number[]>([0])

  function go(index: number) {
    setStep(index)
    setVisited((prev) => (prev.includes(index) ? prev : [...prev, index]))
  }

  const body = (
    <div className="flex flex-col gap-4">
      {step > 0 ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => go(step - 1)}>
            Atrás
          </Button>
        </div>
      ) : null}
      {step === 0 ? <DemoFields /> : step === 1 ? <DemoFields wide /> : <DemoReview />}
    </div>
  )

  return {
    headerContent: <WizardSteps steps={WIZARD_STEPS} current={step} visited={visited} onGo={go} />,
    submitLabel: step < WIZARD_STEPS.length - 1 ? "Continuar" : "Crear registro",
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      if (step < WIZARD_STEPS.length - 1) go(step + 1)
      else toast.success("Registro creado")
    },
    body,
  }
}

interface DemoBranch {
  id: string
  name: string
  addressLine1: string | null
  district: string | null
  isActive: boolean
}

const DEMO_ROWS: DemoBranch[] = [
  {
    id: "1",
    name: "Sede Miraflores",
    addressLine1: "Av. José Pardo 345",
    district: "Miraflores",
    isActive: true,
  },
  { id: "2", name: "Sede Surco", addressLine1: null, district: null, isActive: true },
  {
    id: "3",
    name: "Sede San Isidro",
    addressLine1: "Calle Las Begonias 120",
    district: "San Isidro",
    isActive: false,
  },
  {
    id: "4",
    name: "Sede Barranco",
    addressLine1: "Jr. Colina 210",
    district: "Barranco",
    isActive: true,
  },
  { id: "5", name: "Sede Callao", addressLine1: null, district: "Callao", isActive: true },
]

/** Tabla de demostración para las stories de `MasterDetail`. */
export function DemoTable({ activeId }: { activeId?: string } = {}) {
  const columns = useMemo<ColumnDef<DemoBranch>[]>(
    () => [
      { accessorKey: "name", header: "Nombre" },
      {
        accessorKey: "addressLine1",
        header: "Dirección",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "district",
        header: "Distrito",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "isActive",
        header: "Estado",
        cell: ({ getValue }) => (getValue<boolean>() ? "Activa" : "Inactiva"),
      },
    ],
    [],
  )
  const table = useReactTable({ data: DEMO_ROWS, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <DataTable table={table} isRowActive={activeId ? (row) => row.id === activeId : undefined} />
  )
}

/**
 * Escenario de página: fondo y padding del shell + alto acotado, para que los
 * contenedores con `h-full` (FormPanel) tengan contra qué medir.
 */
export function DemoStage({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="bg-muted min-h-svh w-full p-6">
      <div className={cn("h-[calc(100dvh-3rem)]", className)}>{children}</div>
    </div>
  )
}

/** Alto libre: fondo de página y padding, sin acotar el contenido (tablas, cards). */
export function DemoPage({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("bg-muted min-h-svh w-full p-6", className)}>{children}</div>
}

/* ------------------------------- Pacientes -------------------------------- */

export interface DemoPatient {
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

export const DEMO_PATIENTS: DemoPatient[] = [
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
export function hcLabel(patientNumber: number): string {
  return `HC-${String(patientNumber).padStart(6, "0")}`
}

export function patientInitials(name: string): string {
  return name
    .split(" ")
    .filter((part) => part.length > 2)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
}

/**
 * Fecha sin hora: `new Date("2026-09-12")` la lee como UTC y en es-PE (UTC-5)
 * la mostraría un día antes.
 */
export function formatDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T00:00:00`))
}

export function channelLabel(channel: DemoPatient["channels"][number]): string {
  return channel === "whatsapp" ? "WhatsApp" : "Telegram"
}

export function ChannelBadges({ channels }: { channels: DemoPatient["channels"] }) {
  if (channels.length === 0) return <span className="text-muted-foreground">Sin canal</span>
  return (
    <span className="flex flex-wrap gap-1">
      {channels.map((channel) => (
        <Badge key={channel} variant="secondary">
          {channelLabel(channel)}
        </Badge>
      ))}
    </span>
  )
}

export function patientActions(row: DemoPatient) {
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

export const PATIENT_BASE_COLUMNS: ColumnDef<DemoPatient>[] = [
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
        formatDate(row.original.lastVisit)
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

// Columna de avatar: ocupa el hueco `media`. En la card se agranda cuando la
// ficha es ancha (`@container` de `CardLayout`); en lista no hay contenedor de
// consulta, así que se queda en 40px, el tamaño de `ItemMedia variant="image"`.
export const PATIENT_AVATAR_COLUMN: ColumnDef<DemoPatient> = {
  id: "avatar",
  header: "",
  meta: { view: { role: "media" } },
  cell: ({ row }) => (
    <Avatar className="size-10 @sm:size-14">
      <AvatarFallback>{patientInitials(row.original.name)}</AvatarFallback>
    </Avatar>
  ),
}
