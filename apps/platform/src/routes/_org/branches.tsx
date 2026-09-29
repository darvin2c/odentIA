import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Label,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  isValidE164,
  LoadingState,
  MasterDetail,
  normalizeCountry,
  PageHeader,
  PageShell,
  PhoneInput,
  RowActions,
  TimeZoneSelect,
  useDetailMode,
  useListSearch,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Building2, Plus } from "lucide-react"
import { type FormEvent, useCallback, useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"

export const Route = createFileRoute("/_org/branches")({
  component: BranchesPage,
})

const orgRouteApi = getRouteApi("/_org")

interface Branch {
  id: string
  name: string
  addressLine1: string | null
  district: string | null
  phone: string | null
  /** `null` = hereda la zona horaria de la organización. */
  timezone: string | null
  isActive: boolean
}

const branchSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre"),
  addressLine1: z.string(),
  district: z.string(),
  // El campo de teléfono emite E.164 (o `null` si se deja vacío).
  phone: z
    .string()
    .nullable()
    .refine((value) => value === null || isValidE164(value), "Teléfono inválido"),
  timezoneInherited: z.boolean(),
  timezone: z.string().nullable(),
})

type BranchFormValues = z.infer<typeof branchSchema>

const emptyValues: BranchFormValues = {
  name: "",
  addressLine1: "",
  district: "",
  phone: null,
  timezoneInherited: true,
  timezone: null,
}

/** Valores del formulario para una sucursal; `null` = alta nueva. */
function branchValues(branch: Branch | null): BranchFormValues {
  if (!branch) return emptyValues
  return {
    name: branch.name,
    addressLine1: branch.addressLine1 ?? "",
    district: branch.district ?? "",
    phone: branch.phone ?? null,
    timezoneInherited: branch.timezone === null,
    timezone: branch.timezone ?? null,
  }
}

function BranchesPage() {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const estadoFilter = listSearch.get("estado")
  const sort = listSearch.get("sort")
  const hasCriteria = search !== "" || estadoFilter !== undefined

  const { org } = orgRouteApi.useRouteContext()
  // País y zonas del perfil: definen la máscara del teléfono y las sugerencias.
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
  })

  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Branch | null>(null)
  const [deactivating, setDeactivating] = useState<Branch | null>(null)

  const saveMutation = useMutation({
    mutationFn: async (values: BranchFormValues) => {
      const body = JSON.stringify({
        name: values.name,
        // `null` y no omitir: el PATCH es parcial y una clave ausente deja el
        // valor anterior; vaciar un campo debe persistirse como NULL.
        addressLine1: values.addressLine1 || null,
        district: values.district || null,
        phone: values.phone || null,
        // `null` = la sucursal hereda la zona horaria de la organización.
        timezone: values.timezoneInherited ? null : values.timezone || null,
      })
      if (editing) {
        await apiFetch(`/api/branches/${editing.id}`, { method: "PATCH", body })
      } else {
        await apiFetch("/api/branches", { method: "POST", body })
      }
    },
    onSuccess: async () => {
      // Feedback por toast de ambos resultados: el error ya vivía en onError.
      const message = editing ? "Sucursal actualizada" : "Sucursal creada"
      closeBranchForm()
      toast.success(message)
      await queryClient.invalidateQueries({ queryKey: ["branches"] })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: (branch: Branch) => apiFetch(`/api/branches/${branch.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeactivating(null)
      await queryClient.invalidateQueries({ queryKey: ["branches"] })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  // `defaultValues` deriva de la fila en edición: `useForm` reaplica las opciones
  // en cada render y, mientras el formulario no está tocado, sincroniza los
  // valores con `defaultValues`. Así abrir una fila la vuelca en los campos y
  // `isDirty` significa exactamente "cambios sin guardar". (`form.reset(values)`
  // solo no alcanza: el siguiente render lo pisaría con los `defaultValues` de
  // las opciones.)
  const form = useForm({
    defaultValues: branchValues(editing),
    validators: { onSubmit: branchSchema },
    onSubmit: async ({ value }) => {
      await saveMutation.mutateAsync(value)
    },
  })
  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => state.isDirty)

  const canWrite = usePermission("settings.write")

  /**
   * Abre el formulario sobre una sucursal (o una nueva). El panel lateral no es
   * modal: sin overlay que impida seguir clicando la tabla, la protección contra
   * perder cambios es preguntar antes de reemplazar el contenido. `reset()` sin
   * valores limpia touched/errores y deja que el render siguiente cargue la fila.
   */
  const openBranchForm = useCallback(
    (branch: Branch | null) => {
      if (isDirty && !window.confirm(common.confirm.unsavedMessage)) return
      form.reset()
      setEditing(branch)
      setFormOpen(true)
    },
    [form, isDirty],
  )

  /**
   * Cierra y deja el formulario prístino. El `reset()` es obligatorio: sin él los
   * field-meta (`isTouched`/`isDirty`) sobreviven al cierre con los valores ya
   * guardados, y el próximo abrir preguntaría por cambios que no existen.
   */
  function closeBranchForm() {
    setFormOpen(false)
    setEditing(null)
    form.reset()
  }

  const columns = useMemo<ColumnDef<Branch>[]>(
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
        meta: { view: { primary: true } },
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "isActive",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ getValue }) => (
          <Badge variant={getValue<boolean>() ? "success" : "secondary"}>
            {getValue<boolean>() ? "Activa" : "Inactiva"}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canWrite ? (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[
                {
                  key: "edit",
                  label: "Editar",
                  onSelect: () => openBranchForm(row.original),
                },
                {
                  key: "deactivate",
                  label: "Desactivar",
                  tone: "danger",
                  disabled: !row.original.isActive,
                  onSelect: () => setDeactivating(row.original),
                },
              ]}
            />
          ) : null,
      },
    ],
    [canWrite, openBranchForm],
  )
  const filtered = useMemo(() => {
    const needle = search.toLowerCase()
    const rows = (branchesQuery.data?.data ?? []).filter((row) => {
      if (needle && !row.name.toLowerCase().includes(needle)) return false
      if (estadoFilter === "activa" && !row.isActive) return false
      if (estadoFilter === "inactiva" && row.isActive) return false
      return true
    })
    if (!sort) return rows
    const desc = sort.startsWith("-")
    const field = desc ? sort.slice(1) : sort
    const direction = desc ? -1 : 1
    return [...rows].sort((a, b) => {
      if (field === "estado") return direction * (Number(b.isActive) - Number(a.isActive))
      if (field === "nombre") return direction * a.name.localeCompare(b.name, "es")
      return 0
    })
  }, [branchesQuery.data, search, estadoFilter, sort])

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const formFields = (
    <div className="flex flex-col gap-4">
      <form.Field name="name">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="branch-name">Nombre</FieldLabel>
            <Input
              id="branch-name"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="addressLine1">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="branch-address">Dirección</FieldLabel>
            <Input
              id="branch-address"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="district">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="branch-district">Distrito</FieldLabel>
            <Input
              id="branch-district"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="phone">
        {(field) => {
          const errors = fieldErrorMessages(field.state.meta.errors)
          return (
            <Field>
              <FieldLabel htmlFor="branch-phone">Teléfono</FieldLabel>
              <PhoneInput
                id="branch-phone"
                value={field.state.value}
                onChange={(next) => field.handleChange(next)}
                defaultCountry={countryCode}
                invalid={errors.length > 0}
              />
              <FieldError>{errors[0] ?? null}</FieldError>
            </Field>
          )
        }}
      </form.Field>
      <form.Field name="timezoneInherited">
        {(inheritField) => (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Checkbox
                id="branch-inherit-timezone"
                checked={inheritField.state.value}
                onCheckedChange={(checked) => inheritField.handleChange(checked === true)}
              />
              <Label htmlFor="branch-inherit-timezone">
                Usar la zona horaria de la organización
              </Label>
            </div>
            <form.Field name="timezone">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="branch-timezone">Zona horaria de la sucursal</FieldLabel>
                  <TimeZoneSelect
                    id="branch-timezone"
                    value={field.state.value}
                    onChange={(next) => field.handleChange(next)}
                    suggested={zonesForCountry(countryCode)}
                    disabled={inheritField.state.value}
                  />
                </Field>
              )}
            </form.Field>
          </div>
        )}
      </form.Field>
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeBranchForm,
    title: editing ? `Editar ${editing.name}` : "Nueva sucursal",
    isDirty,
    isSubmitting: saveMutation.isPending,
    submitLabel: common.actions.save,
    cancelLabel: common.actions.cancel,
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      void form.handleSubmit()
    },
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Sucursales"
          subtitle={org.name}
          actions={
            canWrite ? (
              <Button type="button" className="min-h-11" onClick={() => openBranchForm(null)}>
                <Plus aria-hidden />
                Nueva sucursal
              </Button>
            ) : undefined
          }
        />
        <FilterBar
          filters={[
            {
              key: "estado",
              label: "Estado",
              type: "select",
              options: [
                { value: "activa", label: "Activa" },
                { value: "inactiva", label: "Inactiva" },
              ],
            },
          ]}
          sortOptions={[
            { value: "nombre", label: "Nombre" },
            { value: "estado", label: "Estado" },
          ]}
          searchPlaceholder="Buscar sucursal"
        />
        {branchesQuery.isLoading ? (
          <LoadingState />
        ) : branchesQuery.isError ? (
          <ErrorState
            error={branchesQuery.error instanceof ApiError ? branchesQuery.error.shape : null}
            onRetry={() => void branchesQuery.refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={hasCriteria ? common.filters.noResults : "Sin sucursales"}
            description={
              search
                ? `No hay sucursales que coincidan con “${search}”.`
                : hasCriteria
                  ? "No hay sucursales que coincidan con los filtros aplicados."
                  : "Registra tu primera sucursal para operar."
            }
          />
        ) : (
          <DataTable table={table} isRowActive={(row) => formOpen && editing?.id === row.id} />
        )}
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={() => deactivating && deactivateMutation.mutate(deactivating)}
        title={`Desactivar ${deactivating?.name ?? ""}`}
        description="La sucursal dejará de estar operativa. Puedes reactivarla más adelante."
        confirmLabel="Desactivar"
        variant="destructive"
        pending={deactivateMutation.isPending}
      />
    </PageShell>
  )
}
