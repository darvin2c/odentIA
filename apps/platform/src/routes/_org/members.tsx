import {
  assignableRoles,
  ORG_ROLES,
  type OrgRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
} from "@odentia/auth/permissions"
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
  FormPanel,
  fieldErrorMessages,
  LoadingState,
  MasterDetail,
  PageHeader,
  PageShell,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { ProfessionalProfileDrawer } from "../../components/professional-profile-drawer"
import { authClient } from "../../lib/auth-client"
import { useMyRole, usePermission } from "../../lib/crm"
import {
  fetchProfessionalProfiles,
  type ProfessionalProfile,
  registrationLabel,
} from "../../lib/encounters"
import { PageDraftGuard } from "../../lib/page-draft-guard"

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

const ASSIGNABLE_SCHEMA_ROLES: [OrgRole, ...OrgRole[]] = [
  "owner",
  "admin",
  "reception",
  "dentist",
  "cashier",
  "member",
]

const inviteSchema = z.object({
  email: z.string().email("Correo inválido"),
  role: z.enum(ASSIGNABLE_SCHEMA_ROLES),
})

function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role
}

function MembersPage() {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const roleFilter = listSearch.get("rol")
  const sort = listSearch.get("sort")
  const hasCriteria = search !== "" || roleFilter !== undefined
  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null)
  const [editingProfile, setEditingProfile] = useState<ProfessionalProfile | null>(null)

  const { org: routeOrg, session } = orgRouteApi.useRouteContext()
  const myRole = useMyRole()
  const canView = usePermission("settings.read")
  const canManage = usePermission("settings.write")
  const assignable = useMemo(() => assignableRoles(myRole), [myRole])
  // Colegiatura con la que firma cada profesional (ADR 0003).
  const profilesQuery = useQuery({
    queryKey: ["professional-profiles"],
    queryFn: fetchProfessionalProfiles,
    enabled: canView,
  })
  const profileByUser = useMemo(
    () => new Map((profilesQuery.data?.data ?? []).map((p) => [p.userId, p])),
    [profilesQuery.data],
  )

  const orgQuery = useQuery({
    queryKey: ["full-org", routeOrg.id],
    queryFn: async () =>
      (
        await authClient.organization.getFullOrganization({
          query: { organizationId: routeOrg.id },
        })
      ).data as FullOrganization | null,
    enabled: canView,
  })

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
      closeInviteForm()
      await queryClient.invalidateQueries({ queryKey: ["full-org"] })
    },
    onError: (cause) => toast.error(cause.message),
  })

  const form = useForm({
    defaultValues: { email: "", role: "member" as OrgRole },
    validators: { onSubmit: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      await inviteMutation.mutateAsync(value)
      formApi.reset()
    },
  })

  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => !state.isDefaultValue)
  /** Cierra y deja el formulario prístino: sin el reset, el dirty sobrevive al
   *  cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeInviteForm() {
    setFormOpen(false)
    form.reset()
  }

  const roleMutation = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: OrgRole }) => {
      const { error: roleError } = await authClient.organization.updateMemberRole({
        memberId,
        role,
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

  const ownerCount = useMemo(
    () => (org?.members ?? []).filter((member) => member.role === "owner").length,
    [org?.members],
  )

  const columns = useMemo<ColumnDef<Membership>[]>(
    () => [
      {
        accessorKey: "user.name",
        header: "Nombre",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            {row.original.user.name}
            {row.original.userId === session.userId ? <Badge variant="secondary">Tú</Badge> : null}
          </span>
        ),
      },
      {
        accessorKey: "user.email",
        header: "Correo",
        meta: { view: { primary: true } },
        cell: ({ row }) => row.original.user.email,
      },
      {
        accessorKey: "role",
        header: "Rol",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <Badge
            variant={row.original.role === "owner" ? "success" : "secondary"}
            title={ROLE_DESCRIPTIONS[row.original.role as OrgRole] ?? row.original.role}
          >
            {roleLabel(row.original.role)}
          </Badge>
        ),
      },
      {
        id: "registration",
        header: "Colegiatura",
        cell: ({ row }) => {
          const profile = profileByUser.get(row.original.userId)
          const label = profile ? registrationLabel(profile) : null
          if (label) return label
          // Solo a quien atiende le falta para firmar; al resto no le aplica.
          return ["dentist", "owner", "admin"].includes(row.original.role) ? (
            <span className="text-muted-foreground">Sin registrar</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const membership = row.original
          const isSelf = membership.userId === session.userId
          const profile = profileByUser.get(membership.userId)
          const profileItem =
            profile && (canManage || isSelf)
              ? [
                  {
                    key: "profile",
                    label: isSelf ? "Mi perfil profesional…" : "Perfil profesional…",
                    onSelect: () => setEditingProfile(profile),
                  },
                ]
              : []
          // Sin gestión, sobre uno mismo o siendo propietario único: solo el perfil.
          const isLastOwner = membership.role === "owner" && ownerCount <= 1
          if (!canManage || isSelf || isLastOwner) {
            return profileItem.length > 0 ? (
              <div className="text-right">
                <RowActions label={`Acciones de ${membership.user.name}`} items={profileItem} />
              </div>
            ) : null
          }
          return (
            <div className="text-right">
              <RowActions
                label={`Acciones de ${membership.user.name}`}
                items={[
                  ...profileItem,
                  ...assignable.map((role) => ({
                    key: `role-${role}`,
                    label:
                      role === membership.role
                        ? `${roleLabel(role)} (actual)`
                        : `Asignar ${roleLabel(role).toLowerCase()}`,
                    disabled: role === membership.role || roleMutation.isPending,
                    onSelect: () => roleMutation.mutate({ memberId: membership.id, role }),
                  })),
                  {
                    key: "remove",
                    label: "Revocar acceso",
                    tone: "danger" as const,
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
    [assignable, canManage, ownerCount, roleMutation, session.userId, profileByUser],
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
    const roleRanks: Record<string, number> = {
      owner: 0,
      admin: 1,
      reception: 2,
      dentist: 3,
      cashier: 4,
      member: 5,
    }
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

  const formFields = (
    <>
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
                    Rol: {roleLabel(field.state.value)}
                  </Button>
                }
              />
              <DropdownMenuContent>
                {assignable.map((role) => (
                  <DropdownMenuItem
                    key={role}
                    title={ROLE_DESCRIPTIONS[role]}
                    onClick={() => field.handleChange(role)}
                  >
                    {roleLabel(role)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="text-xs text-muted-foreground">
              {ROLE_DESCRIPTIONS[field.state.value as OrgRole]}
            </p>
            <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
          </Field>
        )}
      </form.Field>
    </>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeInviteForm,
    title: "Invitar miembro",
    description: org?.name,
    isDirty,
    isSubmitting: inviteMutation.isPending,
    submitLabel: "Invitar",
    cancelLabel: common.actions.cancel,
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      void form.handleSubmit()
    },
  }

  if (!canView) {
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title="Miembros" subtitle={routeOrg.name} />
        <EmptyState
          title="Sin acceso"
          description="Necesitas permiso de configuración para ver los miembros."
        />
      </PageShell>
    )
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <PageDraftGuard dirty={formOpen && isDirty} />
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Miembros"
          subtitle={org?.name}
          actions={
            canManage ? (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => {
                  form.reset()
                  setFormOpen(true)
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
              options: ORG_ROLES.map((role) => ({ value: role, label: roleLabel(role) })),
            },
          ]}
          sortOptions={[
            { value: "nombre", label: "Nombre" },
            { value: "rol", label: "Rol" },
          ]}
          searchPlaceholder="Buscar miembro"
        />

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
                        {inv.email}{" "}
                        <Badge
                          variant="secondary"
                          title={ROLE_DESCRIPTIONS[inv.role as OrgRole] ?? inv.role}
                        >
                          {roleLabel(inv.role)}
                        </Badge>
                      </span>
                      {canManage ? (
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
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}

      {editingProfile ? (
        <ProfessionalProfileDrawer
          key={editingProfile.userId}
          open
          profile={editingProfile}
          target={editingProfile.userId === session.userId ? "me" : editingProfile.userId}
          onClose={() => setEditingProfile(null)}
        />
      ) : null}

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
