import { Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  fieldErrorMessages,
  PageHeader,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { type FieldDef, useCanWrite } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/fields")({
  component: FieldsPage,
})

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "minúsculas, números y _ (máx 40)"),
  label: z.string().min(1, "Ingresa el label"),
  type: z.enum(["text", "number", "date", "select"]),
  options: z.string(),
})

type FieldFormValues = z.infer<typeof fieldSchema>

function FieldsPage() {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deleting, setDeleting] = useState<FieldDef | null>(null)

  const listQuery = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["fields"] })

  const saveMutation = useMutation({
    mutationFn: async (values: FieldFormValues) => {
      await apiFetch("/api/fields", {
        method: "POST",
        body: JSON.stringify({
          key: values.key,
          label: values.label,
          type: values.type,
          options:
            values.type === "select"
              ? values.options
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
        }),
      })
    },
    onSuccess: () => {
      setDrawerOpen(false)
      form.reset()
      void invalidate()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/fields/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null)
      void invalidate()
    },
  })

  const form = useForm({
    defaultValues: { key: "", label: "", type: "text" as FieldFormValues["type"], options: "" },
    validators: { onSubmit: fieldSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  })

  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const tipoFilter = listSearch.get("tipo")
  const sort = listSearch.get("sort")

  const rows = listQuery.data?.data ?? []

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const matches = rows.filter((field) => {
      if (tipoFilter && field.type !== tipoFilter) return false
      if (needle && !`${field.key} ${field.label}`.toLowerCase().includes(needle)) return false
      return true
    })
    const sortField = (sort ?? "").replace(/^-/, "")
    const desc = (sort ?? "").startsWith("-")
    const compare = (a: FieldDef, b: FieldDef) => {
      if (sortField === "label") return a.label.localeCompare(b.label)
      if (sortField === "tipo") return a.type.localeCompare(b.type)
      return a.key.localeCompare(b.key)
    }
    return [...matches].sort((a, b) => (desc ? -compare(a, b) : compare(a, b)))
  }, [rows, search, tipoFilter, sort])

  const hasCriteria = search.trim() !== "" || Boolean(tipoFilter)

  const columns = useMemo<ColumnDef<FieldDef>[]>(
    () => [
      { accessorKey: "key", header: "Clave" },
      { accessorKey: "label", header: "Label" },
      { accessorKey: "type", header: "Tipo" },
      {
        id: "options",
        header: "Opciones",
        cell: ({ row }) => row.original.options?.join(", ") ?? "—",
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActions
            label={`Acciones de ${row.original.label}`}
            items={[
              {
                key: "delete",
                label: "Eliminar",
                tone: "danger",
                onSelect: () => setDeleting(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canWrite) {
    return <EmptyState title="Sin acceso" description="Solo owner/admin pueden definir campos." />
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Campos personalizados"
        subtitle="Datos extra de contactos (validados por tipo)"
        actions={
          <Button type="button" className="min-h-11" onClick={() => setDrawerOpen(true)}>
            <Plus aria-hidden />
            Nuevo campo
          </Button>
        }
      />
      <FilterBar
        filters={[
          {
            key: "tipo",
            label: "Tipo",
            type: "select",
            options: [
              { value: "text", label: "Texto" },
              { value: "number", label: "Número" },
              { value: "date", label: "Fecha" },
              { value: "select", label: "Opciones" },
            ],
          },
        ]}
        sortOptions={[
          { value: "clave", label: "Clave" },
          { value: "label", label: "Label" },
          { value: "tipo", label: "Tipo" },
        ]}
        searchPlaceholder="Buscar por clave o label"
      />
      {rows.length === 0 && !listQuery.isLoading ? (
        <EmptyState
          title="Sin campos"
          description="Define el primero, p.ej. alergias o sede preferida."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Sin resultados"
          description={
            hasCriteria
              ? "Ningún campo coincide con los criterios de búsqueda."
              : "Todavía no hay campos para mostrar."
          }
        />
      ) : (
        <DataTable table={table} />
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nuevo campo"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={saveMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="key">
            {(field) => (
              <Field>
                <FieldLabel>Clave (a-z, 0-9, _)</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="label">
            {(field) => (
              <Field>
                <FieldLabel>Label</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="type">
            {(field) => (
              <Field>
                <FieldLabel>Tipo</FieldLabel>
                <select
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value as FieldFormValues["type"])}
                >
                  <option value="text">Texto</option>
                  <option value="number">Número</option>
                  <option value="date">Fecha</option>
                  <option value="select">Opciones</option>
                </select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="options">
            {(field) => (
              <Field>
                <FieldLabel>Opciones separadas por coma (solo select)</FieldLabel>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="norte, sur"
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Eliminar ${deleting?.label ?? ""}`}
        description="Los valores ya guardados quedan intactos pero se ocultan."
        confirmLabel="Eliminar"
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
      />
    </div>
  )
}
