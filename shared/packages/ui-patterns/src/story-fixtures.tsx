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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { CalendarDays } from "lucide-react"
import { type FormEvent, type ReactNode, useMemo, useState } from "react"
import { DataTable } from "./data-table.js"
import { DetailSplit } from "./detail/detail-split.js"
import { DetailField, DetailList, DetailSection } from "./detail/detail-rows.js"
import { type WizardStep, WizardSteps } from "./form/wizard-steps.js"
import { type RowActionItem, RowActions } from "./row-actions.js"

/**
 * Fixtures compartidas por las stories: formularios de distintos anchos, un
 * wizard de tres pasos, una tabla y un cuerpo de detalle de lectura. Viven
 * fuera del barrel: son material de Storybook, no API del paquete.
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
export function DemoFields({
  wide = false,
  idPrefix = "demo",
}: {
  wide?: boolean
  idPrefix?: string
}) {
  return (
    <div className={cn(wide ? "grid gap-4 sm:grid-cols-2" : "flex flex-col gap-4")}>
      {FIELD_LABELS.map((label, index) => {
        const id = `${idPrefix}-field-${index}`
        return (
          <Field key={label}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Input id={id} />
          </Field>
        )
      })}
      <Field className={wide ? "sm:col-span-2" : undefined}>
        <FieldLabel htmlFor={`${idPrefix}-notes`}>Notas</FieldLabel>
        <Textarea id={`${idPrefix}-notes`} rows={3} />
      </Field>
    </div>
  )
}

function DemoReview() {
  const entries: Array<[string, string]> = [
    ["Nombre", "Ana Torres"],
    ["Apellido", "Quispe"],
    ["Correo", "ana@odentia.dev"],
    ["Teléfono", "+51999888777"],
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

/** Columnas de la tabla de demostración: las comparten las dos tablas. */
const DEMO_BRANCH_COLUMNS: ColumnDef<DemoBranch>[] = [
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
]

/** Tabla de demostración para las stories de `MasterDetail`. */
export function DemoTable({ activeId }: { activeId?: string } = {}) {
  const table = useReactTable({
    data: DEMO_ROWS,
    columns: DEMO_BRANCH_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <DataTable table={table} isRowActive={activeId ? (row) => row.id === activeId : undefined} />
  )
}

/**
 * Tabla larga: la lista supera el viewport. Es lo que hace visible el detalle
 * `sticky` con scroll de página (y, al revés, la columna que scrollea por
 * dentro mientras la cabecera queda a la vista).
 */
export function DemoLongTable({
  activeId,
  count = 24,
}: {
  activeId?: string
  count?: number
} = {}) {
  const data = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => {
        const base = DEMO_ROWS[index % DEMO_ROWS.length]
        return { ...base, id: `${base.id}-${index}`, name: `${base.name} · ${index + 1}` }
      }),
    [count],
  )
  const table = useReactTable({
    data,
    columns: DEMO_BRANCH_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
  })
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

/* -------------------------------- Detalle --------------------------------- */

/**
 * Cuerpo de detalle de lectura: secciones con campos (`DetailList`) y un bloque
 * de texto largo. El mismo contenido se usa en panel, en drawer y dentro de un
 * contenedor angosto, que es donde se ve el reparto por contenedor.
 */
export function DemoDetailBody() {
  return (
    <>
      <DetailSection title="Datos de la atención">
        <DetailList>
          <DetailField label="Paciente">María Fernanda Quispe Rojas</DetailField>
          <DetailField label="Historia clínica">{hcLabel(24)}</DetailField>
          <DetailField label="Odontólogo">Dra. Lucía Ramos</DetailField>
          <DetailField label="Fecha">
            <time dateTime="2026-09-12T10:30:00-05:00">12/09/2026 · 10:30</time>
          </DetailField>
          <DetailField label="Estado">
            <Badge variant="success">Finalizada</Badge>
          </DetailField>
          <DetailField label="Piezas tratadas">16, 17</DetailField>
          <DetailField label="Presupuesto vinculado">PR-000138 · aceptado</DetailField>
          <DetailField label="Control indicado" />
        </DetailList>
      </DetailSection>

      <DetailSection title="Registro clínico" className="mt-5">
        <DetailList columns={1}>
          <DetailField label="Motivo">
            Dolor a la masticación en el sector superior derecho desde hace cuatro días.
          </DetailField>
          <DetailField label="Evolución">
            Se retira restauración deficiente, se evalúa vitalidad pulpar y se realiza restauración
            con resina compuesta en pieza 16. Se indica control a los 15 días.
          </DetailField>
          <DetailField label="Indicaciones">
            Evitar alimentos duros por 48 horas. Cepillado normal con pasta fluorada.
          </DetailField>
        </DetailList>
      </DetailSection>
    </>
  )
}

/**
 * Acciones secundarias de un detalle: ninguna es «la» acción esperada, así que
 * ninguna merece un botón visible. Sin acciones terminales: «Anular atención»
 * iría aparte, con confirmación, no dentro del menú.
 */
export const DEMO_DETAIL_MENU_ITEMS: RowActionItem[] = [
  {
    key: "full",
    label: "Ver ficha completa",
    onSelect: () => toast.info("Se abriría la ficha del paciente."),
  },
  {
    key: "print",
    label: "Imprimir resumen",
    onSelect: () => toast.info("Se generaría el PDF de la atención."),
  },
  {
    key: "duplicate",
    label: "Duplicar como nueva atención",
    onSelect: () => toast.info("Se abriría una atención nueva precargada."),
  },
  {
    key: "link",
    label: "Copiar enlace",
    onSelect: () => toast.info("Enlace copiado al portapapeles."),
  },
]

/**
 * Acciones de demostración del pie del detalle: la secundaria navega al
 * espacio completo y la principal abre la edición. Ambas avisan por toast, el
 * mismo feedback que usan las stories de formulario.
 */
export function DemoDetailActions() {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => toast.info("Aquí se abriría la ficha completa del paciente.")}
      >
        Ver ficha completa
      </Button>
      <Button type="button" onClick={() => toast.info("Aquí se abriría la edición.")}>
        Editar
      </Button>
    </>
  )
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
    phone: "+51999888777",
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
    phone: "+51987654321",
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
    phone: "+51951234876",
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
    phone: "+51934112550",
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
    phone: "+51962447019",
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

/** Router de memoria: `FilterBar` lee y escribe search plano de la URL. */
export function StoryRouter({ children }: { children: ReactNode }) {
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => children,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
  }, [children])
  return <RouterProvider router={router} />
}

/**
 * La foto de un producto para las stories, sin archivos: un calzado dibujado sobre su color. Las
 * pantallas reales usan la foto que subió la tienda.
 */
export function demoProductImage(color: string, background = "#f1ece6"): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${background}"/><path d="M14 62c10 0 20-4 28-14l8-12c2-3 6-3 8 0l4 8c3 6 9 9 16 10 4 1 6 4 6 8v4H14z" fill="${color}"/><rect x="14" y="70" width="70" height="6" rx="3" fill="#2b2b2b" opacity=".75"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Un pedido con lo que toca, para el detalle de dos columnas (`DetailSplit`): a la derecha la
 * acción con su imagen grande y su botón; a la izquierda el pedido, con secciones que traen
 * botones pequeños (44 px con el dedo).
 */
export function DemoSplitBody() {
  return (
    <DetailSplit
      asideLabel="Lo que toca"
      aside={
        <>
          <p className="rounded-xl bg-warning-soft px-3 py-2.5 text-sm">
            <b>Te toca: </b>Empácalo y dáselo a Jhon. Sale de 2 a 6 p. m.
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="font-heading text-base font-medium">Va en el paquete</h3>
            <p className="text-sm text-muted-foreground">1 producto. Míralo antes de cerrar la caja.</p>
          </div>
          <img
            src={demoProductImage("#1f1f1f", "#f3c6d6")}
            alt="Botín de tacón con pasador, negro, talla 37"
            className="aspect-[4/3] w-full rounded-xl object-cover"
          />
          <Button type="button" className="h-11 w-full">
            Listo: se lo di a Jhon
          </Button>
        </>
      }
    >
      <DetailSection
        title="La etapa"
        className="elevated rounded-xl border bg-card p-4"
        actions={
          <Button type="button" size="sm" variant="ghost">
            Cómo avanza
          </Button>
        }
      >
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="soft">Preparando</Badge>
          <span className="font-medium text-success">Pagado</span>
          <span className="ml-auto font-semibold tabular-nums">S/ 189</span>
        </div>
      </DetailSection>
      <DetailSection title="Lo que lleva" className="elevated rounded-xl border bg-card p-4">
        <DetailList>
          <DetailField label="Producto">Botín de tacón con pasador</DetailField>
          <DetailField label="Variante">negro · 37</DetailField>
        </DetailList>
      </DetailSection>
      <DetailSection
        title="La clienta"
        className="elevated rounded-xl border bg-card p-4"
        actions={
          <Button type="button" size="sm" variant="ghost">
            Ver su ficha
          </Button>
        }
      >
        <p className="text-sm">Brenda Choque · 987 654 321 · le escribe por WhatsApp</p>
      </DetailSection>
    </DetailSplit>
  )
}
