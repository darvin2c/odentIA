import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  FilterBar,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  MasterDetail,
  PageHeader,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { type FieldDef, usePermission } from "../../lib/crm"
import { PageDraftGuard } from "../../lib/page-draft-guard"

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

/** Tipos de campo personalizado: etiqueta única para el select y el filtro. */
const FIELD_TYPES = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "date", label: "Fecha" },
  { value: "select", label: "Opciones" },
] as const

function FieldsPage() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("crm.write")
  const canRead = usePermission("crm.read")
  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [deleting, setDeleting] = useState<FieldDef | null>(null)

  const listQuery = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
    enabled: canRead,
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
      closeFieldForm()
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

  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => !state.isDefaultValue)

  /** Cierra y deja el formulario prístino: sin el reset, el dirty sobrevive al
   *  cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeFieldForm() {
    setFormOpen(false)
    form.reset()
  }

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
      { accessorKey: "key", header: "Clave", meta: { view: { primary: true } } },
      { accessorKey: "label", header: "Label", meta: { view: { role: "title" } } },
      { accessorKey: "type", header: "Tipo", meta: { view: { primary: true } } },
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
                {
                  key: "delete",
                  label: "Eliminar",
                  tone: "danger",
                  onSelect: () => setDeleting(row.original),
                },
              ]}
            />
          ) : null,
      },
    ],
    [canWrite],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canRead) {
    return (
      <div>
        <EmptyState title="Sin acceso" description="Sin permiso de lectura del CRM." />
      </div>
    )
  }

  const formFields = (
    <div className="flex flex-col gap-4">
      <form.Field name="key">
        {(field) => (
          <Field>
            <FieldLabel>Clave (a-z, 0-9, _)</FieldLabel>
            <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="label">
        {(field) => (
          <Field>
            <FieldLabel>Label</FieldLabel>
            <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="type">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="campo-tipo">Tipo</FieldLabel>
            <Select
              value={field.state.value}
              items={Object.fromEntries(FIELD_TYPES.map((t) => [t.value, t.label]))}
              onValueChange={(value) => field.handleChange(value as FieldFormValues["type"])}
            >
              <SelectTrigger id="campo-tipo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeFieldForm,
    title: "Nuevo campo",
    isDirty,
    isSubmitting: saveMutation.isPending,
    submitLabel: "Crear",
    cancelLabel: "Cancelar",
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      void form.handleSubmit()
    },
  }

  return (
    <div className="flex flex-col gap-6">
      <PageDraftGuard dirty={formOpen && isDirty} />
      <MasterDetail
        panel={
          canWrite && mode === "panel" && formOpen ? (
            <FormPanel {...formProps}>{formFields}</FormPanel>
          ) : null
        }
      >
        <PageHeader
          title="Campos personalizados"
          subtitle="Datos extra de contactos (validados por tipo)"
          actions={
            canWrite ? (
              <Button type="button" className="min-h-11" onClick={() => setFormOpen(true)}>
                <Plus aria-hidden />
                Nuevo campo
              </Button>
            ) : undefined
          }
        />
        <FilterBar
          filters={[
            {
              key: "tipo",
              label: "Tipo",
              type: "select",
              options: [...FIELD_TYPES],
            },
          ]}
          sortOptions={[
            { value: "clave", label: "Clave" },
            { value: "label", label: "Label" },
            { value: "tipo", label: "Tipo" },
          ]}
          searchPlaceholder="Buscar por clave o label"
        />
        {listQuery.isPending ? (
          <DataTableSkeleton columnCount={5} rowCount={4} label="Cargando campos…" />
        ) : rows.length === 0 ? (
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
          <DataTable table={table} isFetching={listQuery.isFetching} refreshMessage="Actualizando campos…" />
        )}
      </MasterDetail>
    
      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {canWrite && mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
      {canWrite && (
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          title={`Eliminar ${deleting?.label ?? ""}`}
          description="Los valores ya guardados quedan intactos pero se ocultan."
          confirmLabel="Eliminar"
          onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        />
      )}
    </div>
  )
}
