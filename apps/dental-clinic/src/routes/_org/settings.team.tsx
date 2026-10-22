import {
  assignableRoles,
  ORG_ROLES,
  type OrgRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
} from "@odentia/auth/permissions"
import {
  Badge,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  fieldErrorMessages,
  PageHeader,
  RowActions,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus, Users } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { ProfessionalProfileDrawer } from "../../components/professional-profile-drawer"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { authClient } from "../../lib/auth-client"
import { useMyRole, usePermission } from "../../lib/crm"
import {
  fetchProfessionalProfiles,
  type ProfessionalProfile,
  registrationLabel,
} from "../../lib/encounters"

export const Route = createFileRoute("/_org/settings/team")({
  component: TeamPage,
})

const orgRouteApi = getRouteApi("/_org")

/** El mismo subtítulo con o sin permiso: el título de la página no cambia. */
const TEAM_SUBTITLE = "Quién forma parte de la clínica y qué puede hacer cada persona."

interface FullOrganization {
  id: string
  name: string
  members: { id: string; userId: string; role: string; user: { email: string; name: string } }[]
  invitations: { id: string; email: string; role: string; status: string }[]
}

type Membership = FullOrganization["members"][number]
type Invitation = FullOrganization["invitations"][number]

// Los roles de `@odentia/auth`, no una copia.
const ASSIGNABLE_SCHEMA_ROLES = ORG_ROLES

const inviteSchema = z.object({
  email: z.string().trim().email("Escribe un correo válido"),
  role: z.enum(ASSIGNABLE_SCHEMA_ROLES),
})

function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role
}

function roleDescription(role: string): string {
  return (ROLE_DESCRIPTIONS as Record<string, string>)[role] ?? ""
}

/** Lo que responde la cuenta cuando no acepta la operación, dicho en español. */
const ACCOUNT_ERRORS: Record<string, string> = {
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "Esa persona ya forma parte del equipo.",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "Esa persona ya tiene una invitación pendiente.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
    "La clínica necesita al menos un Propietario.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER:
    "La clínica necesita al menos un Propietario.",
}

/** El motivo conocido o el mensaje propio: nunca el texto interno del proveedor. */
function accountError(error: { code?: string } | null | undefined, fallback: string): Error | null {
  if (!error) return null
  return new Error((error.code ? ACCOUNT_ERRORS[error.code] : undefined) ?? fallback)
}

/** Selector de rol: el estándar, con lo que puede hacer el rol elegido debajo. */
function RoleField({
  id,
  value,
  roles,
  onChange,
}: {
  id: string
  value: OrgRole
  roles: readonly OrgRole[]
  onChange: (role: OrgRole) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Rol</FieldLabel>
      <ChoiceSelect
        id={id}
        value={value}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.target.value as OrgRole)}
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {roleLabel(role)}
          </option>
        ))}
      </ChoiceSelect>
      <FieldDescription id={`${id}-help`}>{roleDescription(value)}</FieldDescription>
    </Field>
  )
}

/**
 * Equipo: quién entra a la clínica y con qué rol. Invitar y cambiar un rol se
 * hacen en la superficie lateral; cambiar un rol, quitar a alguien y cancelar
 * una invitación piden confirmar diciendo qué pasa.
 */
function TeamPage() {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const roleFilter = listSearch.get("rol")
  const sort = listSearch.get("sort")
  const hasCriteria = search !== "" || roleFilter !== undefined
  const [inviteOpen, setInviteOpen] = useState(false)
  /** A quién se le está cambiando el rol, con el rol elegido en el selector. */
  const [roleEdit, setRoleEdit] = useState<{ member: Membership; role: OrgRole } | null>(null)
  const [confirmingRole, setConfirmingRole] = useState(false)
  const [removing, setRemoving] = useState<Membership | null>(null)
  const [cancelling, setCancelling] = useState<Invitation | null>(null)
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
  const profilesLoaded = profilesQuery.data !== undefined

  const orgQuery = useQuery({
    queryKey: ["full-org", routeOrg.id],
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization({
        query: { organizationId: routeOrg.id },
      })
      // Sin respuesta no hay equipo que mostrar: se dice, no se pinta una lista vacía.
      if (error || !data) throw new Error("No pudimos cargar el equipo")
      return data as FullOrganization
    },
    enabled: canView,
  })
  const org = orgQuery.data
  const refreshTeam = () => queryClient.invalidateQueries({ queryKey: ["full-org"] })

  const inviteMutation = useMutation({
    mutationFn: async (values: z.infer<typeof inviteSchema>) => {
      const { error } = await authClient.organization.inviteMember({
        email: values.email.trim(),
        role: values.role,
        organizationId: routeOrg.id,
      })
      const failure = accountError(error, "No pudimos enviar la invitación.")
      if (failure) throw failure
    },
    onSuccess: async (_result, values) => {
      closeInviteForm()
      toast.success(`Invitación enviada a ${values.email.trim()}`)
      await refreshTeam()
    },
    onError: (cause) => toast.error(cause.message),
  })

  const form = useForm({
    defaultValues: { email: "", role: "member" as OrgRole },
    validators: { onSubmit: inviteSchema },
    onSubmit: async ({ value }) => {
      await inviteMutation.mutateAsync(value)
    },
  })

  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => !state.isDefaultValue)
  /** Cierra y deja el formulario prístino: sin el reset, el dirty sobrevive al
   *  cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeInviteForm() {
    setInviteOpen(false)
    form.reset()
  }

  const { mutate: changeRole, isPending: changingRole } = useMutation({
    mutationFn: async ({ member, role }: { member: Membership; role: OrgRole }) => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId: member.id,
        role,
        organizationId: routeOrg.id,
      })
      const failure = accountError(error, "No pudimos cambiar el rol.")
      if (failure) throw failure
    },
    onSuccess: async (_result, { member, role }) => {
      setConfirmingRole(false)
      setRoleEdit(null)
      toast.success(`${member.user.name} ahora es ${roleLabel(role)}`)
      await refreshTeam()
    },
    onError: (cause) => {
      setConfirmingRole(false)
      toast.error(cause.message)
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (member: Membership) => {
      const { error } = await authClient.organization.removeMember({
        memberIdOrEmail: member.id,
        organizationId: routeOrg.id,
      })
      const failure = accountError(error, "No pudimos quitar a esa persona del equipo.")
      if (failure) throw failure
    },
    onSuccess: async (_result, member) => {
      setRemoving(null)
      toast.success(`${member.user.name} ya no forma parte del equipo`)
      await refreshTeam()
    },
    onError: (cause) => toast.error(cause.message),
  })

  const cancelInvitationMutation = useMutation({
    mutationFn: async (invitation: Invitation) => {
      const { error } = await authClient.organization.cancelInvitation({
        invitationId: invitation.id,
      })
      const failure = accountError(error, "No pudimos cancelar la invitación.")
      if (failure) throw failure
    },
    onSuccess: async (_result, invitation) => {
      setCancelling(null)
      toast.success(`Invitación de ${invitation.email} cancelada`)
      await refreshTeam()
    },
    onError: (cause) => toast.error(cause.message),
  })

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
            title={roleDescription(row.original.role) || undefined}
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
          // Sin la lista de perfiles no se sabe: no se afirma que falte.
          if (!profilesLoaded) return <span className="text-muted-foreground">—</span>
          // Solo a quien atiende le falta para firmar; al resto no le aplica.
          return ["clinician", "owner", "admin"].includes(row.original.role) ? (
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
                    label: isSelf ? "Mi perfil profesional" : "Perfil profesional",
                    onSelect: () => setEditingProfile(profile),
                  },
                ]
              : []
          // Sin gestión, sobre uno mismo o con un único Propietario: solo el perfil.
          const isLastOwner = membership.role === "owner" && ownerCount <= 1
          // Un rol que quien administra no puede asignar tampoco lo puede quitar (el de Propietario).
          const outOfReach = !assignable.includes(membership.role as OrgRole)
          const items =
            !canManage || isSelf || isLastOwner || outOfReach
              ? profileItem
              : [
                  ...profileItem,
                  {
                    key: "role",
                    label: "Cambiar rol",
                    onSelect: () =>
                      setRoleEdit({ member: membership, role: membership.role as OrgRole }),
                  },
                  {
                    key: "remove",
                    label: "Quitar del equipo",
                    tone: "danger" as const,
                    onSelect: () => setRemoving(membership),
                  },
                ]
          return items.length > 0 ? (
            <div className="text-right">
              <RowActions label={`Acciones de ${membership.user.name}`} items={items} />
            </div>
          ) : null
        },
      },
    ],
    [assignable, canManage, ownerCount, session.userId, profileByUser, profilesLoaded],
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
      clinician: 3,
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

  if (!canView) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Equipo" subtitle={TEAM_SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const openInvite = () => {
    form.reset()
    setInviteOpen(true)
  }
  const pendingInvitations = (org?.invitations ?? []).filter((inv) => inv.status === "pending")
  const roleChanged = roleEdit !== null && roleEdit.role !== roleEdit.member.role

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Equipo"
        subtitle={TEAM_SUBTITLE}
        primary={
          canManage ? { label: "Invitar al equipo", icon: <Plus aria-hidden />, onClick: openInvite } : undefined
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
        searchPlaceholder="Buscar en el equipo"
      />

      {org === undefined ? (
        orgQuery.isError ? (
          <ErrorState
            title="No pudimos cargar el equipo"
            message="Comprueba tu conexión y vuelve a intentarlo."
            onRetry={() => void orgQuery.refetch()}
          />
        ) : (
          <DataTableSkeleton columnCount={5} rowCount={4} label="Cargando el equipo…" />
        )
      ) : (
        <>
          {filteredMembers.length === 0 ? (
            hasCriteria ? (
              <EmptyState
                icon={Users}
                title={common.filters.noResults}
                description={
                  search
                    ? `Nadie del equipo coincide con “${search}”.`
                    : "Nadie del equipo coincide con los filtros elegidos."
                }
              />
            ) : (
              <EmptyState
                icon={Users}
                title="Aún no hay nadie en el equipo"
                description="Invita a quienes trabajan en la clínica y elige el rol de cada persona."
                actionLabel={canManage ? "Invitar al equipo" : undefined}
                onAction={canManage ? openInvite : undefined}
              />
            )
          ) : (
            <DataTable table={table} />
          )}

          {pendingInvitations.length > 0 ? (
            <section aria-labelledby="team-invitations" className="flex flex-col gap-2">
              <h2 id="team-invitations" className="text-sm font-medium">
                Invitaciones pendientes
              </h2>
              <ul className="flex flex-col gap-2">
                {pendingInvitations.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate">{inv.email}</span>
                      <Badge variant="secondary" title={roleDescription(inv.role) || undefined}>
                        {roleLabel(inv.role)}
                      </Badge>
                    </span>
                    {canManage ? (
                      <RowActions
                        label={`Acciones de la invitación de ${inv.email}`}
                        items={[
                          {
                            key: "cancelar",
                            label: "Cancelar invitación",
                            tone: "danger",
                            onSelect: () => setCancelling(inv),
                          },
                        ]}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <FormDrawer
        open={inviteOpen}
        onClose={closeInviteForm}
        title="Invitar al equipo"
        description="Le llega un correo para crear su cuenta y entrar a la clínica con el rol que elijas."
        isDirty={isDirty}
        isSubmitting={inviteMutation.isPending}
        submitLabel="Invitar"
        cancelLabel={common.actions.cancel}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="email">
            {(field) => {
              const error = fieldErrorMessages(field.state.meta.errors)[0]
              return (
                <Field>
                  <FieldLabel htmlFor="invite-email">Invitar por correo</FieldLabel>
                  <Input
                    id="invite-email"
                    type="email"
                    autoComplete="off"
                    aria-invalid={error ? true : undefined}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError>{error ?? null}</FieldError>
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="role">
            {(field) => (
              <RoleField
                id="invite-role"
                value={field.state.value}
                roles={assignable}
                onChange={(role) => field.handleChange(role)}
              />
            )}
          </form.Field>
        </div>
      </FormDrawer>

      {roleEdit ? (
        <FormDrawer
          key={roleEdit.member.id}
          open
          onClose={() => setRoleEdit(null)}
          title={`Rol de ${roleEdit.member.user.name}`}
          description="El rol decide qué puede ver y hacer en la clínica."
          isSubmitting={changingRole}
          submitDisabled={!roleChanged}
          submitLabel="Cambiar rol"
          cancelLabel={common.actions.cancel}
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            // Nada cambia todavía: primero se dice qué pasa y se confirma.
            if (roleChanged) setConfirmingRole(true)
          }}
        >
          <RoleField
            id="member-role"
            value={roleEdit.role}
            roles={assignable}
            onChange={(role) => setRoleEdit({ ...roleEdit, role })}
          />
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
        open={confirmingRole && roleEdit !== null}
        onClose={() => setConfirmingRole(false)}
        onConfirm={() => roleEdit && changeRole(roleEdit)}
        title={`Cambiar el rol de ${roleEdit?.member.user.name ?? ""}`}
        description={
          roleEdit
            ? `Pasa de ${roleLabel(roleEdit.member.role)} a ${roleLabel(roleEdit.role)}. Como ${roleLabel(roleEdit.role)}: ${roleDescription(roleEdit.role)}`
            : ""
        }
        confirmLabel="Cambiar rol"
        variant="default"
        pending={changingRole}
      />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && removeMutation.mutate(removing)}
        title={`Quitar a ${removing?.user.name ?? ""} del equipo`}
        description="Dejará de entrar a esta clínica con su cuenta. Lo que ya registró se conserva."
        confirmLabel="Quitar del equipo"
        variant="destructive"
        pending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={() => cancelling && cancelInvitationMutation.mutate(cancelling)}
        title="Cancelar la invitación"
        description={`El enlace que recibió ${cancelling?.email ?? ""} dejará de servir. Puedes invitarle de nuevo cuando quieras.`}
        confirmLabel="Cancelar invitación"
        cancelLabel="Volver"
        variant="destructive"
        pending={cancelInvitationMutation.isPending}
      />
    </div>
  )
}
