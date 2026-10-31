import { Badge, Button, FieldGroup, Separator, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  ErrorState,
  FormDrawer,
  ImageAdjust,
  type ImageAdjustValue,
  PageHeader,
  PageShell,
  PASSWORD_MIN_LENGTH,
  PersonAvatar,
  renderAdjustedImage,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  usePasswordRequirements,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Monitor, Smartphone } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { API_URL, authClient } from "../../lib/auth-client"
import { AUTH_NETWORK, authError, authErrorMessage, authFormMessage } from "../../lib/auth-error"
import { tenantUrl } from "../../lib/host"
import { panelWords } from "../../lib/brand"
import { parseUserAgent, relativeTime } from "../../lib/user-agent"
import { safeNext } from "../../lib/safe-next"
import {
  TWO_FACTOR_EDITS,
  type TwoFactorEdit,
  TwoFactorCodesDrawer,
  TwoFactorOffDrawer,
  TwoFactorPhoneDrawer,
  TwoFactorRow,
  TwoFactorSetupDrawer,
  useTwoFactorStatus,
} from "../../components/two-factor"
import { ClinicsSkeleton, ProfilePageSkeleton, SessionsSkeleton } from "../../components/skeletons/profile"

type ProfileEdit = "profile" | "password" | "email" | TwoFactorEdit

export const Route = createFileRoute("/_app/profile")({
  // `next`: la clínica que pidió la verificación en dos pasos, para volver al activarla.
  validateSearch: (search: Record<string, unknown>): { edit?: ProfileEdit; next?: string } => {
    const edit = search.edit
    const known = edit === "profile" || edit === "password" || edit === "email" || TWO_FACTOR_EDITS.includes(edit as TwoFactorEdit)
    return {
      ...(known ? { edit: edit as ProfileEdit } : {}),
      ...(typeof search.next === "string" ? { next: search.next } : {}),
    }
  },
  pendingComponent: ProfilePageSkeleton,
  component: ProfilePage,
})

const appRouteApi = getRouteApi("/_app")

// `/update-user` no pone límites al nombre ni a los apellidos (packages/auth).
const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Ingresa tu nombre"),
  lastName: z.string().trim().min(1, "Ingresa tus apellidos"),
})

// Los mismos límites que Better Auth (8 a 128 caracteres).
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Ingresa tu contraseña actual"),
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `Mínimo ${PASSWORD_MIN_LENGTH} caracteres`)
      .max(128, "Usa como mucho 128 caracteres."),
    confirmPassword: z.string().min(1, "Confirma tu nueva contraseña"),
  })
  .refine((value) => value.confirmPassword === value.newPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  })

const emailSchema = z.object({
  email: z.string().trim().email("Correo inválido"),
})

/** Lo que no sea de un campo, dicho para una acción suelta: sin red, que no hubo conexión. */
function actionErrorMessage(error: unknown): string {
  return authFormMessage(error) ?? submitErrorMessage(error)
}

/** Sin imagen no hay foto que guardar: se dice junto a «Ajustar imagen». */
const photoSchema = z.object({
  file: z.custom<ImageAdjustValue | null>((value) => value !== null, "Elige una imagen y encuádrala."),
})

/**
 * La foto de Mi perfil con «Ajustar imagen» (tablero 6): se encuadra y se sube
 * ya recortada. «Cancelar» deja la anterior; guardar la pone en la cuenta y
 * desde ahí la ven la barra lateral de cada clínica y este perfil. El dato se
 * llama `file`, como en el cuerpo de la subida: lo que rechace el servidor
 * (formato, peso) se dice junto a la imagen.
 */
function ProfilePhotoDrawer({ open, name, onClose }: { open: boolean; name: string; onClose: () => void }) {
  const form = useAppForm({
    defaultValues: { file: null as ImageAdjustValue | null },
    validators: { onSubmit: photoSchema },
    onSubmit: async ({ value }) => {
      if (!value.file) return
      const { blob, ext } = await renderAdjustedImage(value.file)
      const formData = new FormData()
      formData.append("file", blob, `avatar.${ext}`)
      const res = await fetch(`${API_URL}/api/uploads/avatar`, {
        method: "POST",
        credentials: "include",
        body: formData,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: ApiError["shape"] } | null
        throw new ApiError(res.status, body?.error ?? {})
      }
      const { data } = (await res.json()) as { data: { url: string } }
      const { error: updateError } = await authClient.updateUser({ image: data.url })
      if (updateError) throw authError(updateError)
      form.reset()
      toast.success("Foto actualizada")
      onClose()
    },
  })
  const surface = useFormSurface(form, { formMessage: authFormMessage })
  const saving = useStore(form.store, (state) => state.isSubmitting)
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        form.reset()
        onClose()
      }}
      title="Tu foto"
      description="Elige un archivo, arrástralo o toma la foto, y encuádrala antes de guardar."
      submitLabel="Guardar"
    >
      {open ? (
        <form.AppField name="file">
          {(field) => (
            <field.Group legend={<span className="sr-only">Tu foto</span>}>
              {(control) => (
                <ImageAdjust
                  shape="person"
                  name={name}
                  disabled={saving}
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(next) => {
                    field.handleChange(next)
                    if (next) field.handleBlur()
                  }}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
      ) : null}
    </FormDrawer>
  )
}

function ProfilePage() {
  const { session } = appRouteApi.useRouteContext()
  const { edit, next } = useSearch({ from: "/_app/profile" })
  const twoFactor = useTwoFactorStatus()
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

  function closeDrawer() {
    void navigate({ to: "/profile", search: {}, replace: true })
  }

  const [photoOpen, setPhotoOpen] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function handleRemovePhoto() {
    setRemoving(true)
    try {
      const { error: updateError } = await authClient.updateUser({ image: null })
      if (updateError) {
        toast.error(authErrorMessage(updateError))
        return
      }
      toast.success("Foto quitada")
    } catch {
      toast.error(AUTH_NETWORK)
    } finally {
      setRemoving(false)
    }
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
          <p className="text-sm text-muted-foreground">Tu contraseña y la verificación en dos pasos.</p>
        </div>
        <div>
          <Link to="/profile" search={{ edit: "password" }}>
            <Button type="button" variant="outline">
              Cambiar contraseña
            </Button>
          </Link>
        </div>
        <Separator />
        <TwoFactorRow />
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
        onClose={closeDrawer}
      />
      <ChangePasswordDrawer open={edit === "password"} onClose={closeDrawer} />
      <TwoFactorSetupDrawer
        open={edit === "two-factor"}
        email={user.email}
        status={twoFactor.data}
        onClose={(activated) => {
          // Activada desde la clínica que la pide: de vuelta a ella.
          const back = activated ? safeNext(next) : null
          if (back) window.location.assign(back)
          else closeDrawer()
        }}
      />
      <TwoFactorPhoneDrawer open={edit === "two-factor-phone"} status={twoFactor.data} onClose={closeDrawer} />
      <TwoFactorCodesDrawer open={edit === "two-factor-codes"} email={user.email} status={twoFactor.data} onClose={closeDrawer} />
      <TwoFactorOffDrawer open={edit === "two-factor-off"} status={twoFactor.data} onClose={closeDrawer} />
      <ChangeEmailDrawer key={user.email} open={edit === "email"} currentEmail={user.email} onClose={closeDrawer} />
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
      const { error } =
        revokeTarget.kind === "one"
          ? await authClient.revokeSession({ token: revokeTarget.token })
          : await authClient.revokeOtherSessions()
      if (error) {
        toast.error(authErrorMessage(error))
        return
      }
      await queryClient.invalidateQueries({ queryKey: ["sessions"] })
      toast.success(revokeTarget.kind === "one" ? "Sesión cerrada" : "Otras sesiones cerradas")
      setRevokeTarget(null)
    } catch {
      toast.error(AUTH_NETWORK)
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
          <SkeletonRegion message="Cargando tus sesiones…">
            <SessionsSkeleton />
          </SkeletonRegion>
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
  onClose,
}: {
  open: boolean
  initialFirstName: string
  initialLastName: string
  onClose: () => void
}) {
  const form = useAppForm({
    defaultValues: { firstName: initialFirstName, lastName: initialLastName },
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      const firstName = value.firstName.trim()
      const lastName = value.lastName.trim()
      const { error } = await authClient.updateUser({ name: `${firstName} ${lastName}`.trim(), firstName, lastName })
      if (error) throw authError(error)
      toast.success("Perfil actualizado")
      onClose()
    },
  })
  const close = () => {
    form.reset()
    onClose()
  }

  return (
    <FormDrawer
      {...useFormSurface(form, { formMessage: authFormMessage })}
      open={open}
      title="Editar perfil"
      onClose={close}
    >
      <FieldGroup>
        <form.AppField name="firstName">
          {(field) => <field.TextField id="profile-first-name" label="Nombre" type="text" autoComplete="given-name" />}
        </form.AppField>
        <form.AppField name="lastName">
          {(field) => <field.TextField id="profile-last-name" label="Apellidos" type="text" autoComplete="family-name" />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

function ChangePasswordDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const form = useAppForm({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.changePassword({
        currentPassword: value.currentPassword,
        newPassword: value.newPassword,
        revokeOtherSessions: true,
      })
      // Una cuenta que solo entra con Google (`CREDENTIAL_ACCOUNT_NOT_FOUND`) no tiene
      // campo que corregir: se explica junto al botón.
      if (error)
        throw authError(error, {
          fields: {
            INVALID_PASSWORD: "currentPassword",
            PASSWORD_TOO_SHORT: "newPassword",
            PASSWORD_TOO_LONG: "newPassword",
            PASSWORD_COMPROMISED: "newPassword",
          },
        })
      toast.success("Contraseña actualizada")
      close()
    },
  })
  const newPassword = useStore(form.store, (state) => state.values.newPassword)
  const { requirements } = usePasswordRequirements(newPassword)
  const close = () => {
    form.reset()
    onClose()
  }

  return (
    <FormDrawer
      {...useFormSurface(form, { formMessage: authFormMessage })}
      open={open}
      title="Cambiar contraseña"
      onClose={close}
    >
      <FieldGroup>
        <form.AppField name="currentPassword">
          {(field) => <field.PasswordField id="password-current" label="Contraseña actual" autoComplete="current-password" />}
        </form.AppField>
        <form.AppField name="newPassword">
          {(field) => (
            <field.PasswordField id="password-new" label="Nueva contraseña" autoComplete="new-password" requirements={requirements} />
          )}
        </form.AppField>
        <form.AppField name="confirmPassword">
          {(field) => <field.PasswordField id="password-confirm" label="Confirma la nueva contraseña" autoComplete="new-password" />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

function ChangeEmailDrawer({
  open,
  currentEmail,
  onClose,
}: {
  open: boolean
  currentEmail: string
  onClose: () => void
}) {
  const form = useAppForm({
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
      // Un correo que ya tiene cuenta no da error (Better Auth no revela qué cuentas
      // existen); lo único atribuible es el formato del correo.
      const { error } = await authClient.changeEmail({
        newEmail: value.email.trim(),
        callbackURL: `${window.location.origin}/profile`,
      })
      if (error) throw authError(error, { fields: { INVALID_EMAIL: "email" } })
      toast.success("Te enviamos un correo de confirmación a tu dirección actual")
      onClose()
    },
  })
  const close = () => {
    form.reset()
    onClose()
  }

  return (
    <FormDrawer
      {...useFormSurface(form, { formMessage: authFormMessage })}
      open={open}
      title="Cambiar correo"
      onClose={close}
    >
      <form.AppField name="email">
        {(field) => <field.TextField id="profile-email" label="Nuevo correo" type="email" autoComplete="email" />}
      </form.AppField>
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
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const orgsQuery = useQuery({
    queryKey: ["account-organizations"],
    queryFn: async () => accountOrgsSchema.parse(await apiFetch<unknown>("/api/account/organizations")),
  })

  async function handleLeave() {
    if (!leaveTarget) return
    setLeaving(true)
    setLeaveError(null)
    try {
      await apiFetch("/api/account/organizations/" + encodeURIComponent(leaveTarget.id) + "/leave", {
        method: "POST",
      })
      await queryClient.invalidateQueries({ queryKey: ["account-organizations"] })
      toast.success("Saliste de la clínica")
      setLeaveTarget(null)
    } catch (error) {
      // Única propietaria (409), sin permiso (403)…: dentro del diálogo, no detrás.
      setLeaveError(actionErrorMessage(error))
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
        <SkeletonRegion message="Cargando tus clínicas…">
          <ClinicsSkeleton />
        </SkeletonRegion>
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
        error={leaveError}
        onConfirm={() => void handleLeave()}
        onClose={() => {
          setLeaveTarget(null)
          setLeaveError(null)
        }}
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
  const [error, setError] = useState<string | null>(null)

  async function handleClose() {
    setPending(true)
    setError(null)
    try {
      await apiFetch("/api/account/close", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      })
    } catch (failure) {
      // Única propietaria de una clínica (409), cuenta bloqueada (403): dentro del diálogo.
      setError(actionErrorMessage(failure))
      setPending(false)
      return
    }
    // La cuenta ya está cerrada: a la entrada aunque cerrar la sesión falle por la red.
    await authClient.signOut().catch(() => undefined)
    setPending(false)
    await navigate({ to: "/login" })
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
        error={error}
        onConfirm={() => void handleClose()}
        onClose={() => {
          setOpen(false)
          setError(null)
        }}
      />
    </div>
  )
}
