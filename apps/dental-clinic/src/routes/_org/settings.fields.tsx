import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  FilterBar,
  FormDrawer,
  PageHeader,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useId, useMemo, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { DiscardDraftDialog, useReportDirty, useSideForm } from "../../components/settings/side-form"
import { ApiError, apiFetch } from "../../lib/api"
import { type FieldDef, usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/fields")({
  component: ContactFieldsPage,
})

const TITLE = "Campos de contacto"
const SUBTITLE = "Los datos propios que tu clínica guarda de cada contacto."

type FieldType = "text" | "number" | "date" | "select"

/** El tipo de campo, dicho con palabras: la misma frase en la lista, el filtro y el formulario. */
const FIELD_TYPES: Array<{ value: FieldType; label: string; hint: string }> = [
  { value: "text", label: "Texto", hint: "Una respuesta escrita, corta." },
  { value: "number", label: "Número", hint: "Solo cifras." },
  { value: "date", label: "Fecha", hint: "Un día del calendario." },
  { value: "select", label: "Lista de opciones", hint: "Se elige una de las opciones que definas." },
]
const TYPE_ITEMS: Record<string, string> = Object.fromEntries(FIELD_TYPES.map((type) => [type.value, type.label]))

function typeLabel(type: string): string {
  return TYPE_ITEMS[type] ?? "Otro"
}

/** Una opción por línea, sin vacías ni repetidas. */
function toOptions(text: string): string[] {
  return [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))]
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/**
 * Campos de contacto: lo que la clínica quiere guardar de cada contacto además
 * de lo que ya trae el sistema. La lista se edita en la superficie lateral.
 * Definir campos es de quien administra la clínica y también de quien trabaja
 * con contactos (`crm.write`), la misma regla que abre el apartado y que
 * aplica el servidor.
 */
function ContactFieldsPage() {
  const queryClient = useQueryClient()
  const canConfigure = usePermission("settings.read")
  const canSell = usePermission("crm.read")
  const canRead = canConfigure || canSell
  const canWrite = usePermission("crm.write")
  // Al lado: un campo nuevo o el que se edita.
  const sideForm = useSideForm<FieldDef>()
  const openForm = sideForm.open
  const [deleting, setDeleting] = useState<FieldDef | null>(null)

  const listQuery = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
    enabled: canRead,
    retry: 1,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["fields"] })

  const deleteMutation = useMutation({
    mutationFn: (field: FieldDef) => apiFetch(`/api/fields/${field.id}`, { method: "DELETE" }),
    onSuccess: (_result, field) => {
      setDeleting(null)
      toast.success(`Campo «${field.label}» eliminado`)
      void invalidate()
    },
    onError: (error) => {
      setDeleting(null)
      toast.error(errorText(error, "No pudimos eliminar el campo. Vuelve a intentarlo."))
    },
  })

  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const typeFilter = listSearch.get("tipo")
  const sort = listSearch.get("sort")

  const rows = listQuery.data?.data ?? []

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const matches = rows.filter((field) => {
      if (typeFilter && field.type !== typeFilter) return false
      if (needle && !field.label.toLowerCase().includes(needle)) return false
      return true
    })
    const sortField = (sort ?? "").replace(/^-/, "")
    const desc = (sort ?? "").startsWith("-")
    const compare = (a: FieldDef, b: FieldDef) =>
      sortField === "tipo"
        ? typeLabel(a.type).localeCompare(typeLabel(b.type)) || a.label.localeCompare(b.label)
        : a.label.localeCompare(b.label)
    return [...matches].sort((a, b) => (desc ? -compare(a, b) : compare(a, b)))
  }, [rows, search, typeFilter, sort])

  const hasCriteria = search.trim() !== "" || Boolean(typeFilter)

  const columns = useMemo<ColumnDef<FieldDef>[]>(
    () => [
      { accessorKey: "label", header: "Nombre", meta: { view: { role: "title" } } },
      {
        accessorKey: "type",
        header: "Tipo",
        meta: { view: { primary: true } },
        cell: ({ row }) => typeLabel(row.original.type),
      },
      {
        id: "options",
        header: "Opciones",
        cell: ({ row }) => row.original.options?.join(", ") ?? "—",
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canWrite ? (
            <RowActions
              label={`Acciones de ${row.original.label}`}
              items={[
                { key: "edit", label: "Editar", onSelect: () => openForm(row.original) },
                { key: "delete", label: "Eliminar", tone: "danger", onSelect: () => setDeleting(row.original) },
              ]}
            />
          ) : null,
      },
    ],
    [canWrite, openForm],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const neverLoaded = listQuery.isError && listQuery.data === undefined

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        primary={
          canWrite ? { label: "Nuevo campo", icon: <Plus aria-hidden />, onClick: () => openForm(null) } : undefined
        }
      />

      {listQuery.isPending ? (
        <DataTableSkeleton columnCount={4} rowCount={4} label="Cargando los campos de contacto…" />
      ) : neverLoaded ? (
        <SettingsLoadError what="los campos de contacto" onRetry={() => void listQuery.refetch()} />
      ) : (
        <>
          {listQuery.isError ? (
            <SettingsLoadError stale what="los campos de contacto" onRetry={() => void listQuery.refetch()} />
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              title="Aún no hay campos"
              description="Sirven para guardar en cada contacto lo que tu clínica quiere saber: cómo nos conoció, su sede preferida."
              {...(canWrite ? { actionLabel: "Agrega el primer campo", onAction: () => openForm(null) } : {})}
            />
          ) : (
            <>
              <FilterBar
                filters={[
                  {
                    key: "tipo",
                    label: "Tipo",
                    type: "select",
                    options: FIELD_TYPES.map(({ value, label }) => ({ value, label })),
                  },
                ]}
                sortOptions={[
                  { value: "nombre", label: "Nombre" },
                  { value: "tipo", label: "Tipo" },
                ]}
                searchPlaceholder="Buscar por nombre"
              />
              {filtered.length === 0 ? (
                <EmptyState
                  title="Sin resultados"
                  description={
                    hasCriteria
                      ? "Ningún campo coincide con la búsqueda. Cambia el texto o quita el filtro."
                      : "No hay campos para mostrar."
                  }
                />
              ) : (
                <DataTable
                  table={table}
                  {...(canWrite ? { onRowClick: (field: FieldDef) => openForm(field) } : {})}
                  isRowActive={(row) => sideForm.form?.target?.id === row.id}
                  isFetching={listQuery.isFetching}
                  refreshMessage="Actualizando los campos…"
                />
              )}
            </>
          )}
        </>
      )}

      {canWrite && sideForm.form ? (
        <FieldForm
          key={sideForm.form.opening}
          field={sideForm.form.target}
          onDirtyChange={sideForm.setDirty}
          onClose={sideForm.close}
          onSaved={() => {
            sideForm.close()
            void invalidate()
          }}
        />
      ) : null}
      <DiscardDraftDialog form={sideForm} what="otro campo" />

      {canWrite ? (
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          title={`Eliminar el campo «${deleting?.label ?? ""}»`}
          description="Deja de verse en la ficha de cada contacto. Lo que ya estaba guardado en él se descarta la próxima vez que se editen los campos de ese contacto."
          confirmLabel="Eliminar"
          pending={deleteMutation.isPending}
          onConfirm={() => deleting && deleteMutation.mutate(deleting)}
        />
      ) : null}
    </div>
  )
}

/**
 * Un campo nuevo o el que se edita. Solo se escribe el nombre: la clave con que
 * se guarda la genera el servidor. Al editar, el tipo ya no cambia.
 */
function FieldForm({
  field,
  onDirtyChange,
  onClose,
  onSaved,
}: {
  field: FieldDef | null
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
  onSaved: () => void
}) {
  const ids = useId()
  const initialOptions = (field?.options ?? []).join("\n")
  const [label, setLabel] = useState(field?.label ?? "")
  const [type, setType] = useState<FieldType>((field?.type as FieldType | undefined) ?? "text")
  const [options, setOptions] = useState(initialOptions)
  const [errors, setErrors] = useState<{ label?: string; options?: string }>({})

  const save = useMutation({
    mutationFn: (values: { label: string; type: FieldType; options: string[] }) => {
      const withOptions = values.type === "select" ? { options: values.options } : {}
      return field
        ? apiFetch(`/api/fields/${field.id}`, {
            method: "PATCH",
            body: JSON.stringify({ label: values.label, ...withOptions }),
          })
        : apiFetch("/api/fields", {
            method: "POST",
            body: JSON.stringify({ label: values.label, type: values.type, ...withOptions }),
          })
    },
    onSuccess: (_result, values) => {
      toast.success(`Campo «${values.label}» guardado`)
      onSaved()
    },
  })

  const isDirty = label !== (field?.label ?? "") || options !== initialOptions || (!field && type !== "text")
  useReportDirty(isDirty, onDirtyChange)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={field ? "Editar campo" : "Nuevo campo"}
      isDirty={isDirty}
      isSubmitting={save.isPending}
      error={save.isError ? errorText(save.error, "No pudimos guardar el campo. Vuelve a intentarlo.") : null}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const name = label.trim()
        const list = toOptions(options)
        const next: { label?: string; options?: string } = {}
        if (!name) next.label = "Escribe el nombre del campo"
        if (type === "select" && list.length === 0) next.options = "Escribe al menos una opción"
        setErrors(next)
        if (next.label || next.options) return
        save.mutate({ label: name, type, options: list })
      }}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-nombre`}>Nombre</FieldLabel>
          <Input
            id={`${ids}-nombre`}
            value={label}
            maxLength={120}
            placeholder="Cómo nos conoció"
            aria-invalid={errors.label ? true : undefined}
            onChange={(event) => setLabel(event.target.value)}
          />
          <FieldDescription>Así se lee en la ficha de cada contacto.</FieldDescription>
          {errors.label ? <FieldError>{errors.label}</FieldError> : null}
        </Field>
        {field ? (
          <Field>
            <FieldTitle>Tipo</FieldTitle>
            <p className="text-sm">{typeLabel(field.type)}</p>
            <FieldDescription>
              No se cambia después de crear el campo: lo que ya está guardado depende de él.
            </FieldDescription>
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor={`${ids}-tipo`}>Tipo</FieldLabel>
            <Select value={type} items={TYPE_ITEMS} onValueChange={(value) => setType((value as FieldType | null) ?? "text")}>
              <SelectTrigger id={`${ids}-tipo`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {FIELD_TYPES.find((item) => item.value === type)?.hint} Después no se puede cambiar.
            </FieldDescription>
          </Field>
        )}
        {type === "select" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-opciones`}>Opciones</FieldLabel>
            <Textarea
              id={`${ids}-opciones`}
              value={options}
              rows={5}
              placeholder={"Redes sociales\nRecomendación\nPasó por la clínica"}
              aria-invalid={errors.options ? true : undefined}
              onChange={(event) => setOptions(event.target.value)}
            />
            <FieldDescription>
              Una por línea.
              {field
                ? " Si quitas una, los contactos que la tenían la conservan; al editar sus campos habrá que elegir otra."
                : ""}
            </FieldDescription>
            {errors.options ? <FieldError>{errors.options}</FieldError> : null}
          </Field>
        ) : null}
      </div>
    </FormDrawer>
  )
}
