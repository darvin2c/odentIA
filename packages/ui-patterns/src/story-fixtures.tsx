import { Button, cn, Field, FieldLabel, Input, Textarea, toast } from "@odentia/ui"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { type FormEvent, type ReactNode, useMemo, useState } from "react"
import { DataTable } from "./data-table.js"
import { type WizardStep, WizardSteps } from "./form/wizard-steps.js"

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
