import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldError,
  FieldLabel,
  Input,
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
  fieldErrorMessages,
  LoadingState,
  PageHeader,
  RowActions,
  useListSearch,
  PageShell,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { authClient } from "../../lib/auth-client"

export const Route = createFileRoute("/_org/members")({
  component: MembersPage,
})

const orgRouteApi = getRouteApi("/_org")

interface FullOrganization {
  id: string
  name: string
  members: { id: string; userId: string; role: string; user: { email: string; name: string } }[]
  invitations: { id: string; email: string; role: string; status: string }[]
}

const inviteSchema = z.object({
  email: z.string().email("Correo inválido"),
  role: z.enum(["member", "admin"]),
})

function MembersPage() {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const roleFilter = listSearch.get("rol")
  const sort = listSearch.get("sort")
  const hasCriteria = search !== "" || roleFilter !== undefined
  const [inviteOpen, setInviteOpen] = useState(false)
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null)

  const { org: routeOrg, session } = orgRouteApi.useRouteContext()

  const orgQuery = useQuery({
    queryKey: ["full-org", routeOrg.id],
    queryFn: async () =>
      (
        await authClient.organization.getFullOrganization({
          query: { organizationId: routeOrg.id },
        })
      ).data as FullOrganization | null,
  })

  const myRole = orgQuery.data?.members.find((m) => m.userId === session.userId)?.role ?? "member"
  const canWrite = myRole === "owner" || myRole === "admin"
  const inviteMutation = useMutation({
    mutationFn: async (values: z.infer<typeof inviteSchema>) => {
      const { error: inviteError } = await authClient.organization.inviteMember({
        email: values.email,
        role: values.role,
        organizationId: routeOrg.id,
      })
      if (inviteError) throw new Error(inviteError.message ?? "No se pudo invitar.")
    },
    onSuccess: async () => {
      setInviteOpen(false)
      await queryClient.invalidateQueries({ queryKey: ["full-org"] })
    },
    onError: (cause) => toast.error(cause.message),
  })

  const form = useForm({
    defaultValues: { email: "", role: "member" as "member" | "admin" },
    validators: { onSubmit: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      await inviteMutation.mutateAsync(value)
      formApi.reset()
    },
  })

  const roleMutation = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
      const { error: roleError } = await authClient.organization.updateMemberRole({
        memberId,
        role: role as "member" | "admin",
      })
      if (roleError) throw new Error(roleError.message ?? "No se pudo cambiar el rol.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["full-org"] }),
    onError: (cause) => toast.error(cause.message),
  })

  const removeMutation = useMutation({
    mutationFn: async (memberIdOrEmail: string) => {
      const { error: removeError } = await authClient.organization.removeMember({
        memberIdOrEmail,
        organizationId: routeOrg.id,
      })
      if (removeError) throw new Error(removeError.message ?? "No se pudo revocar.")
    },
    onSuccess: async () => {
      setRemoving(null)
      await queryClient.invalidateQueries({ queryKey: ["full-org"] })
    },
    onError: (cause) => toast.error(cause.message),
  })

  const cancelInvitationMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      const { error: cancelError } = await authClient.organization.cancelInvitation({
        invitationId,
      })
      if (cancelError) throw new Error(cancelError.message ?? "No se pudo revocar la invitación.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["full-org"] }),
    onError: (cause) => toast.error(cause.message),
  })

  const org = orgQuery.data

  type Membership = NonNullable<typeof org>["members"][number]

  const columns = useMemo<ColumnDef<Membership>[]>(
    () => [
      {
        accessorKey: "user.name",
        header: "Nombre",
        cell: ({ row }) => row.original.user.name,
      },
      {
        accessorKey: "user.email",
        header: "Correo",
        cell: ({ row }) => row.original.user.email,
      },
      {
        accessorKey: "role",
        header: "Rol",
        cell: ({ row }) => (
          <Badge variant={row.original.role === "owner" ? "success" : "secondary"}>
            {row.original.role}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const membership = row.original
          if (!canWrite || membership.role === "owner") return null
          return (
            <div className="text-right">
              <RowActions
                label={`Acciones de ${membership.user.name}`}
                items={[
                  {
                    key: "role",
                    label: membership.role === "admin" ? "Bajar a member" : "Subir a admin",
                    onSelect: () =>
                      roleMutation.mutate({
                        memberId: membership.id,
                        role: membership.role === "admin" ? "member" : "admin",
                      }),
                  },
                  {
                    key: "remove",
                    label: "Revocar acceso",
                    tone: "danger",
                    onSelect: () =>
                      setRemoving({ id: membership.id, label: membership.user.email }),
                  },
                ]}
              />
            </div>
          )
        },
      },
    ],
    [canWrite, roleMutation],
  )
  const filteredMembers = useMemo(() => {
    const needle = search.toLowerCase()
    const rows = (org?.members ?? []).filter((member) => {
      if (roleFilter && member.role !== roleFilter) return false
      if (needle && !`${member.user.name} ${member.user.email}`.toLowerCase().includes(needle))
        return false
      return true
    })
    if (!sort) return rows
    const desc = sort.startsWith("-")
    const field = desc ? sort.slice(1) : sort
    const direction = desc ? -1 : 1
    const roleRanks: Record<string, number> = { owner: 0, admin: 1, member: 2 }
    return [...rows].sort((a, b) => {
      if (field === "rol")
        return direction * ((roleRanks[a.role] ?? 99) - (roleRanks[b.role] ?? 99))
      if (field === "nombre") return direction * a.user.name.localeCompare(b.user.name, "es")
      return 0
    })
  }, [org?.members, search, roleFilter, sort])

  const table = useReactTable({
    data: filteredMembers,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Miembros"
        subtitle={org?.name}
        actions={
          canWrite ? (
            <Button
              type="button"
              className="min-h-11"
              onClick={() => {
                form.reset()
                setInviteOpen(true)
              }}
            >
              <Plus aria-hidden />
              Invitar miembro
            </Button>
          ) : undefined
        }
      />
      <FilterBar
        filters={[
          {
            key: "rol",
            label: "Rol",
            type: "select",
            options: [
              { value: "owner", label: "Owner" },
              { value: "admin", label: "Admin" },
              { value: "member", label: "Member" },
            ],
          },
        ]}
        sortOptions={[
          { value: "nombre", label: "Nombre" },
          { value: "rol", label: "Rol" },
        ]}
        searchPlaceholder="Buscar miembro"
      />

      <FormDrawer
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invitar miembro"
        description={org?.name}
        isSubmitting={inviteMutation.isPending}
        submitLabel="Invitar"
        cancelLabel={common.actions.cancel}
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="email">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="invite-email">Invitar por correo</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                placeholder="colega@clinica.pe"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="role">
          {(field) => (
            <Field>
              <FieldLabel>Rol</FieldLabel>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button type="button" variant="outline">
                      Rol: {field.state.value === "admin" ? "admin" : "member"}
                    </Button>
                  }
                />
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => field.handleChange("member")}>
                    member
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => field.handleChange("admin")}>
                    admin
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>
          )}
        </form.Field>
      </FormDrawer>

      {orgQuery.isLoading ? (
        <LoadingState />
      ) : orgQuery.isError ? (
        <ErrorState
          message="No se pudo cargar la organización."
          onRetry={() => void orgQuery.refetch()}
        />
      ) : !org ? (
        <EmptyState title="Sin organización activa" />
      ) : (
        <>
          {filteredMembers.length === 0 ? (
            <EmptyState
              title={hasCriteria ? common.filters.noResults : "Sin miembros"}
              description={
                hasCriteria
                  ? "No hay miembros que coincidan con los filtros aplicados."
                  : "Invita a tu primer miembro para colaborar."
              }
            />
          ) : (
            <DataTable table={table} />
          )}

          {org.invitations.filter((inv) => inv.status === "pending").length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Invitaciones pendientes</h2>
              {org.invitations
                .filter((inv) => inv.status === "pending")
                .map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
                  >
                    <span>
                      {inv.email} <Badge variant="secondary">{inv.role}</Badge>
                    </span>
                    {canWrite ? (
                      <RowActions
                        label={`Acciones de ${inv.email}`}
                        items={[
                          {
                            key: "revocar",
                            label: "Revocar",
                            tone: "danger",
                            onSelect: () => cancelInvitationMutation.mutate(inv.id),
                          },
                        ]}
                      />
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && removeMutation.mutate(removing.id)}
        title={`Revocar acceso de ${removing?.label ?? ""}`}
        description="El miembro perderá acceso a esta organización."
        confirmLabel="Revocar"
        cancelLabel={common.actions.cancel}
        variant="destructive"
        pending={removeMutation.isPending}
      />
    </PageShell>
  )
}
