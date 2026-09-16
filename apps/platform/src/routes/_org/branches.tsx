import { Badge, Button, Field, FieldError, FieldLabel, Input, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  fieldErrorMessages,
  LoadingState,
  PageHeader,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Building2, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"

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
  isActive: boolean
}

const branchSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre"),
  addressLine1: z.string(),
  district: z.string(),
  phone: z.string(),
})

type BranchFormValues = z.infer<typeof branchSchema>

const emptyValues: BranchFormValues = { name: "", addressLine1: "", district: "", phone: "" }

function BranchesPage() {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const estadoFilter = listSearch.get("estado")
  const sort = listSearch.get("sort")
  const hasCriteria = search !== "" || estadoFilter !== undefined

  const { org } = orgRouteApi.useRouteContext()

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
  })

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Branch | null>(null)
  const [deactivating, setDeactivating] = useState<Branch | null>(null)

  const saveMutation = useMutation({
    mutationFn: async (values: BranchFormValues) => {
      const body = JSON.stringify({
        name: values.name,
        addressLine1: values.addressLine1 || undefined,
        district: values.district || undefined,
        phone: values.phone || undefined,
      })
      if (editing) {
        await apiFetch(`/api/branches/${editing.id}`, { method: "PATCH", body })
      } else {
        await apiFetch("/api/branches", { method: "POST", body })
      }
    },
    onSuccess: async () => {
      setDrawerOpen(false)
      setEditing(null)
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

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: branchSchema },
    onSubmit: async ({ value }) => {
      await saveMutation.mutateAsync(value)
    },
  })

  const canWrite = useCanWrite()

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
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "isActive",
        header: "Estado",
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
                  onSelect: () => {
                    setEditing(row.original)
                    form.reset()
                    form.setFieldValue("name", row.original.name)
                    form.setFieldValue("addressLine1", row.original.addressLine1 ?? "")
                    form.setFieldValue("district", row.original.district ?? "")
                    form.setFieldValue("phone", row.original.phone ?? "")
                    setDrawerOpen(true)
                  },
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
    [canWrite, form],
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sucursales"
        subtitle={org.name}
        actions={
          canWrite ? (
            <Button
              type="button"
              className="min-h-11"
              onClick={() => {
                setEditing(null)
                form.reset()
                setDrawerOpen(true)
              }}
            >
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
        <DataTable table={table} />
      )}

      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? `Editar ${editing.name}` : "Nueva sucursal"}
        isSubmitting={saveMutation.isPending}
        submitLabel={common.actions.save}
        cancelLabel={common.actions.cancel}
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
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
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branch-phone">Teléfono</FieldLabel>
                <Input
                  id="branch-phone"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>

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
    </div>
  )
}

/** Rol del usuario en la org del host: owner/admin pueden escribir. */
function useCanWrite(): boolean {
  const { org, session } = orgRouteApi.useRouteContext()
  const me = org.members.find((m) => m.userId === session.userId)
  const role = me?.role ?? "member"
  return role === "owner" || role === "admin"
}
