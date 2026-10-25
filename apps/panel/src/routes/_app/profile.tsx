import {
  Badge,
  Button,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Separator,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  ErrorState,
  FormDrawer,
  fieldErrorMessages,
  ImageAdjust,
  type ImageAdjustValue,
  PageHeader,
  PageShell,
  PersonAvatar,
  renderAdjustedImage,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Monitor, Smartphone } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { API_URL, authClient } from "../../lib/auth-client"
import { tenantUrl } from "../../lib/host"
import { panelWords } from "../../lib/brand"
 import { parseUserAgent, relativeTime } from "../../lib/user-agent"

export const Route = createFileRoute("/_app/profile")({
  validateSearch: (search: Record<string, unknown>): { edit?: "profile" | "password" | "email" } =>
    search.edit === "profile" || search.edit === "password" || search.edit === "email"
      ? { edit: search.edit }
      : {},
  component: ProfilePage,
})

const appRouteApi = getRouteApi("/_app")

const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Ingresa tu nombre"),
  lastName: z.string().trim().min(1, "Ingresa tus apellidos"),
})

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Ingresa tu contraseña actual"),
    newPassword: z.string().min(8, "Mínimo 8 caracteres"),
    confirmPassword: z.string().min(1, "Confirma tu nueva contraseña"),
  })
  .refine((value) => value.confirmPassword === value.newPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  })

const emailSchema = z.object({
  email: z.string().email("Correo inválido"),
})

/**
 * La foto de Mi perfil con «Ajustar imagen» (tablero 6): se encuadra y se sube
 * ya recortada. «Cancelar» deja la anterior; guardar la pone en la cuenta y
 * desde ahí la ven la barra lateral de cada clínica y este perfil.
 */
function ProfilePhotoDrawer({ open, name, onClose }: { open: boolean; name: string; onClose: () => void }) {
  const [value, setValue] = useState<ImageAdjustValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const close = () => {
    if (saving) return
    setValue(null)
    setError(null)
    onClose()
  }
  async function save() {
    if (!value) return
    setSaving(true)
    setError(null)
    try {
      const { blob, ext } = await renderAdjustedImage(value)
      const formData = new FormData()
      formData.append("file", blob, `avatar.${ext}`)
      const res = await fetch(`${API_URL}/api/uploads/avatar`, {
        method: "POST",
        credentials: "include",
        body: formData,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        setError(body?.error?.message ?? common.errors.generic)
        return
      }
      const { data } = (await res.json()) as { data: { url: string } }
      const { error: updateError } = await authClient.updateUser({ image: data.url })
      if (updateError) {
        setError(common.errors.generic)
        return
      }
      setValue(null)
      toast.success("Foto actualizada")
      onClose()
    } catch {
      setError(common.errors.generic)
    } finally {
      setSaving(false)
    }
  }
  return (
    <FormDrawer
      open={open}
      onClose={close}
      title="Tu foto"
      description="Elige un archivo, arrástralo o toma la foto, y encuádrala antes de guardar."
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      isDirty={value !== null}
      isSubmitting={saving}
      submitDisabled={!value}
      submitLabel="Guardar"
      error={error}
    >
      {open ? <ImageAdjust shape="person" name={name} disabled={saving} onChange={setValue} /> : null}
    </FormDrawer>
  )
}

function ProfilePage() {
  const { session } = appRouteApi.useRouteContext()
  const { edit } = useSearch({ from: "/_app/profile" })
  const navigate = useNavigate()
  const live = authClient.useSession().data?.user
  // La foto sale de la cuenta (`image`), la misma que ve la barra lateral.
  const user = live
    ? {
        name: live.name,
        firstName: live.firstName ?? "",
        lastName: live.lastName ?? "",
        email: live.email,
        avatarUrl: live.image ?? null,
      }
    : {
        name: session.name,
        firstName: session.firstName,
        lastName: session.lastName,
        email: session.email,
        avatarUrl: session.image,
      }

  const [profileError, setProfileError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)

  function closeDrawer() {
    setProfileError(null)
    setPasswordError(null)
    setEmailError(null)
    void navigate({ to: "/profile", search: {}, replace: true })
  }

  const [photoOpen, setPhotoOpen] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function handleRemovePhoto() {
    setRemoving(true)
    const { error: updateError } = await authClient.updateUser({ image: null })
    setRemoving(false)
    if (updateError) {
      toast.error(common.errors.generic)
      return
    }
    toast.success("Foto quitada")
  }

  const avatar = (
    <PersonAvatar
      name={user.name}
      givenNames={user.firstName}
      familyName={user.lastName}
      src={user.avatarUrl}
      className="size-16"
      fallbackClassName="text-lg"
    />
  )

  return (
    <PageShell className="flex max-w-2xl flex-col gap-6">
      <PageHeader title="Mi perfil" subtitle="Administra tu información de cuenta y seguridad" />
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Perfil</div>
          <p className="text-sm text-muted-foreground">Tu información personal en {panelWords.name}.</p>
        </div>
        <div>
          <div className="flex items-center gap-4">
            {avatar}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </div>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setPhotoOpen(true)}>
                {user.avatarUrl ? "Cambiar foto" : "Subir foto"}
              </Button>
              {user.avatarUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={removing}
                  onClick={() => void handleRemovePhoto()}
                >
                  {removing ? "Quitando…" : "Quitar foto"}
                </Button>
              ) : null}
            </div>
          </div>
          <ProfilePhotoDrawer open={photoOpen} name={user.name} onClose={() => setPhotoOpen(false)} />
          <Separator className="my-2" />
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">Nombre</p>
              <p className="text-sm text-muted-foreground">
                {`${user.firstName} ${user.lastName}`.trim() || user.name}
              </p>
            </div>
            <Link to="/profile" search={{ edit: "profile" }}>
              <Button type="button" variant="outline" size="sm">
                Editar
              </Button>
            </Link>
          </div>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">Correo</p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
            <Link to="/profile" search={{ edit: "email" }}>
              <Button type="button" variant="outline" size="sm">
                Cambiar
              </Button>
            </Link>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Seguridad</div>
          <p className="text-sm text-muted-foreground">Actualiza tu contraseña de acceso.</p>
        </div>
        <div>
          <Link to="/profile" search={{ edit: "password" }}>
            <Button type="button" variant="outline">
              Cambiar contraseña
            </Button>
          </Link>
        </div>
      </div>
      <SessionsCard />
      <MyClinicsCard />
      <MyInvitationsCard />
      <CloseAccountCard />
      <EditProfileDrawer
        key={`${user.firstName}|${user.lastName}`}
        open={edit === "profile"}
        initialFirstName={user.firstName}
        initialLastName={user.lastName}
        error={profileError}
        onError={setProfileError}
        onClose={closeDrawer}
      />
      <ChangePasswordDrawer
        open={edit === "password"}
        error={passwordError}
        onError={setPasswordError}
        onClose={closeDrawer}
      />
      <ChangeEmailDrawer
        key={user.email}
        open={edit === "email"}
        currentEmail={user.email}
        error={emailError}
        onError={setEmailError}
        onClose={closeDrawer}
      />
    </PageShell>
  )
}

function SessionsCard() {
  const queryClient = useQueryClient()
  const currentToken = authClient.useSession().data?.session.token
  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await authClient.listSessions()
      if (error) throw new Error(error.message ?? common.errors.generic)
      return data ?? []
    },
  })
  const [revokeTarget, setRevokeTarget] = useState<
    { kind: "one"; token: string } | { kind: "others" } | null
  >(null)
  const [revokePending, setRevokePending] = useState(false)

  async function handleConfirmRevoke() {
    if (!revokeTarget) return
    setRevokePending(true)
    try {
      if (revokeTarget.kind === "one") {
        await authClient.revokeSession({ token: revokeTarget.token })
      } else {
        await authClient.revokeOtherSessions()
      }
      await queryClient.invalidateQueries({ queryKey: ["sessions"] })
      toast.success(revokeTarget.kind === "one" ? "Sesión cerrada" : "Otras sesiones cerradas")
      setRevokeTarget(null)
    } catch {
      toast.error(common.errors.generic)
    } finally {
      setRevokePending(false)
    }
  }

  const sessions = sessionsQuery.data ?? []

  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Sesiones activas</div>
        <p className="text-sm text-muted-foreground">Dispositivos con acceso a tu cuenta.</p>
        {sessions.length > 1 ? (
          <div className="self-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRevokeTarget({ kind: "others" })}
            >
              Cerrar otras sesiones
            </Button>
          </div>
        ) : null}
      </div>
      <div>
        {sessionsQuery.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : sessionsQuery.isError ? (
          <ErrorState
            error={sessionsQuery.error}
            onRetry={() => {
              void sessionsQuery.refetch()
            }}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {sessions.map((item) => {
              const { browser, os } = parseUserAgent(item.userAgent)
              const isCurrent = item.token === currentToken
              const Icon = os === "Android" || os === "iOS" ? Smartphone : Monitor
              return (
                <li
                  key={item.token}
                  className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                >
                  <Icon className="size-5 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">
                        {browser} · {os}
                      </span>
                      {isCurrent ? <Badge variant="success">Actual</Badge> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Última actividad {relativeTime(item.updatedAt)} ·{" "}
                      {item.ipAddress ?? "IP desconocida"}
                    </p>
                  </div>
                  {isCurrent ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onClick={() => setRevokeTarget({ kind: "one", token: item.token })}
                    >
                      Revocar
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget?.kind === "others" ? "Cerrar otras sesiones" : "Revocar sesión"}
        description={
          revokeTarget?.kind === "others"
            ? "Todos los demás dispositivos perderán acceso a tu cuenta."
            : "Este dispositivo perderá acceso a tu cuenta de inmediato."
        }
        confirmLabel={revokeTarget?.kind === "others" ? "Cerrar sesiones" : "Revocar"}
        variant="destructive"
        pending={revokePending}
        onConfirm={() => void handleConfirmRevoke()}
        onClose={() => setRevokeTarget(null)}
      />
    </div>
  )
}

function EditProfileDrawer({
  open,
  initialFirstName,
  initialLastName,
  error,
  onError,
  onClose,
}: {
  open: boolean
  initialFirstName: string
  initialLastName: string
  error: string | null
  onError: (error: string | null) => void
  onClose: () => void
}) {
  const form = useForm({
    defaultValues: { firstName: initialFirstName, lastName: initialLastName },
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      const { error: updateError } = await authClient.updateUser({
        name: `${value.firstName} ${value.lastName}`.trim(),
        firstName: value.firstName,
        lastName: value.lastName,
      })
      if (updateError) {
        onError(common.errors.generic)
        return
      }
      toast.success("Perfil actualizado")
      onClose()
    },
  })
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const isDirty = useStore(form.store, (state) => state.isDirty)

  return (
    <FormDrawer
      open={open}
      title="Editar perfil"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        onError(null)
        void form.handleSubmit()
      }}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      error={error}
    >
      <FieldGroup>
        <form.Field name="firstName">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="profile-first-name">Nombre</FieldLabel>
              <Input
                id="profile-first-name"
                type="text"
                autoComplete="given-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="lastName">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="profile-last-name">Apellidos</FieldLabel>
              <Input
                id="profile-last-name"
                type="text"
                autoComplete="family-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
      </FieldGroup>
    </FormDrawer>
  )
}

function ChangePasswordDrawer({
  open,
  error,
  onError,
  onClose,
}: {
  open: boolean
  error: string | null
  onError: (error: string | null) => void
  onClose: () => void
}) {
  const form = useForm({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      const { error: changeError } = await authClient.changePassword({
        currentPassword: value.currentPassword,
        newPassword: value.newPassword,
        revokeOtherSessions: true,
      })
      if (changeError) {
        onError(
          "No se pudo cambiar la contraseña. Verifica tu contraseña actual e inténtalo de nuevo.",
        )
        return
      }
      toast.success("Contraseña actualizada")
      onClose()
    },
  })
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const isDirty = useStore(form.store, (state) => state.isDirty)

  return (
    <FormDrawer
      open={open}
      title="Cambiar contraseña"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        onError(null)
        void form.handleSubmit()
      }}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      error={error}
    >
      <FieldGroup>
        <form.Field name="currentPassword">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="password-current">Contraseña actual</FieldLabel>
              <Input
                id="password-current"
                type="password"
                autoComplete="current-password"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="newPassword">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="password-new">Nueva contraseña</FieldLabel>
              <Input
                id="password-new"
                type="password"
                autoComplete="new-password"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="confirmPassword">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="password-confirm">Confirma la nueva contraseña</FieldLabel>
              <Input
                id="password-confirm"
                type="password"
                autoComplete="new-password"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
            </Field>
          )}
        </form.Field>
      </FieldGroup>
    </FormDrawer>
  )
}

function ChangeEmailDrawer({
  open,
  currentEmail,
  error,
  onError,
  onClose,
}: {
  open: boolean
  currentEmail: string
  error: string | null
  onError: (error: string | null) => void
  onClose: () => void
}) {
  const form = useForm({
    defaultValues: { email: "" },
    validators: {
      onSubmit: emailSchema.refine(
        (value) => value.email.trim().toLowerCase() !== currentEmail.toLowerCase(),
        {
          message: "El nuevo correo es igual al actual",
          path: ["email"],
        },
      ),
    },
    onSubmit: async ({ value }) => {
      const { error: changeError } = await authClient.changeEmail({
        newEmail: value.email,
        callbackURL: `${window.location.origin}/profile`,
      })
      if (changeError) {
        onError(
          changeError.message?.includes("exist")
            ? "Ese correo ya está en uso."
            : common.errors.generic,
        )
        return
      }
      toast.success("Te enviamos un correo de confirmación a tu dirección actual")
      onClose()
    },
  })
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const isDirty = useStore(form.store, (state) => state.isDirty)

  return (
    <FormDrawer
      open={open}
      title="Cambiar correo"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        onError(null)
        void form.handleSubmit()
      }}
      isDirty={isDirty}
      isSubmitting={isSubmitting}
      error={error}
    >
      <form.Field name="email">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="profile-email">Nuevo correo</FieldLabel>
            <Input
              id="profile-email"
              type="email"
              autoComplete="email"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)[0] ?? null}</FieldError>
          </Field>
        )}
      </form.Field>
    </FormDrawer>
  )
}

const accountOrgsSchema = z.object({
  data: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      slug: z.string(),
      role: z.string(),
      roleLabel: z.string(),
      canLeave: z.boolean(),
      product: z.string(),
      provisioning: z.object({ hasProfile: z.boolean(), hasBranch: z.boolean() }),
    }),
  ),
})

const accountInvitesSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      organizationId: z.string(),
      organizationName: z.string(),
      slug: z.string(),
      roleLabel: z.string(),
    }),
  ),
})

function MyClinicsCard() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [leaveTarget, setLeaveTarget] = useState<{ id: string; name: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const orgsQuery = useQuery({
    queryKey: ["account-organizations"],
    queryFn: async () => accountOrgsSchema.parse(await apiFetch<unknown>("/api/account/organizations")),
  })

  async function handleLeave() {
    if (!leaveTarget) return
    setLeaving(true)
    try {
      await apiFetch("/api/account/organizations/" + encodeURIComponent(leaveTarget.id) + "/leave", {
        method: "POST",
      })
      await queryClient.invalidateQueries({ queryKey: ["account-organizations"] })
      toast.success("Saliste de la clínica")
      setLeaveTarget(null)
    } catch {
      toast.error(common.errors.generic)
    } finally {
      setLeaving(false)
    }
  }

  const orgs = orgsQuery.data?.data ?? []
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Mis clínicas</div>
        <p className="text-sm text-muted-foreground">Clínicas a las que perteneces y tu rol en cada una.</p>
      </div>
      {orgsQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : orgsQuery.isError ? (
        <ErrorState
          error={orgsQuery.error}
          onRetry={() => {
            void orgsQuery.refetch()
          }}
        />
      ) : orgs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aún no perteneces a ninguna clínica.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orgs.map((org) => {
            const incomplete = !org.provisioning.hasProfile || !org.provisioning.hasBranch
            const canFinish = (org.role === "owner" || org.role === "admin") && incomplete
            return (
              <li
                key={org.organizationId}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{org.organizationName}</p>
                  <p className="text-xs text-muted-foreground">
                    {org.roleLabel}
                    {incomplete ? " · Alta incompleta" : ""}
                  </p>
                </div>
                <span className="ml-auto flex gap-2">
                  {canFinish ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        void navigate({
                          to: "/onboarding",
                          search: { continue: org.organizationId },
                        })
                      }
                    >
                      Terminar alta
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => window.location.assign(tenantUrl(org.slug, "/home", org.product))}
                    >
                      Abrir
                    </Button>
                  )}
                  {org.canLeave ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLeaveTarget({ id: org.organizationId, name: org.organizationName })
                      }
                    >
                      Salir
                    </Button>
                  ) : org.role === "owner" ? (
                    <span className="self-center text-xs text-muted-foreground">
                      Única propietaria
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <ConfirmDialog
        open={leaveTarget !== null}
        title="Salir de la clínica"
        description={`Dejarás de tener acceso a ${leaveTarget?.name ?? ""}. Podrán volverte a invitar.`}
        confirmLabel="Salir"
        variant="destructive"
        pending={leaving}
        onConfirm={() => void handleLeave()}
        onClose={() => setLeaveTarget(null)}
      />
    </div>
  )
}

function MyInvitationsCard() {
  const navigate = useNavigate()
  const invitesQuery = useQuery({
    queryKey: ["account-invitations"],
    queryFn: async () => accountInvitesSchema.parse(await apiFetch<unknown>("/api/account/invitations/pending")),
  })
  const invites = invitesQuery.data?.data ?? []
  if (invitesQuery.isPending || invitesQuery.isError || invites.length === 0) return null
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Invitaciones pendientes</div>
        <p className="text-sm text-muted-foreground">Clínicas que te invitaron y aún no aceptas.</p>
      </div>
      <ul className="flex flex-col gap-3">
        {invites.map((invite) => (
          <li
            key={invite.id}
            className="flex items-center gap-3 rounded-lg border p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{invite.organizationName}</p>
              <p className="text-xs text-muted-foreground">{invite.roleLabel}</p>
            </div>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() =>
                void navigate({
                  to: "/accept-invitation/$invitationId",
                  params: { invitationId: invite.id },
                })
              }
            >
              Aceptar
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CloseAccountCard() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function handleClose() {
    setPending(true)
    try {
      await apiFetch("/api/account/close", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      })
      await authClient.signOut()
      await navigate({ to: "/login" })
    } catch {
      toast.error(common.errors.generic)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border border-destructive/30 bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Cerrar cuenta</div>
        <p className="text-sm text-muted-foreground">
          Sales de tus clínicas y se bloquea tu acceso. Tu trabajo previo conserva tu autoría.
          Si eres la única propietaria de alguna clínica, nombra antes a otra persona.
        </p>
      </div>
      <div>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
          Cerrar mi cuenta
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title="Cerrar tu cuenta"
        description="Perderás el acceso a tus clínicas. Esta acción bloquea tu cuenta de inmediato."
        confirmLabel="Cerrar cuenta"
        variant="destructive"
        pending={pending}
        onConfirm={() => void handleClose()}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
