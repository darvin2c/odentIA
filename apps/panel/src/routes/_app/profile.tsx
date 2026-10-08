import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  Badge,
  Button,
  Field,
  FieldError,
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
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Monitor, Smartphone, XIcon } from "lucide-react"
import { useRef, useState } from "react"
import { z } from "zod"
import { API_URL, authClient } from "../../lib/auth-client"
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

const AVATAR_MAX_BYTES = 2 * 1024 * 1024

function avatarKindLabel(mime: string): string | null {
  if (mime === "image/png") return "PNG"
  if (mime === "image/jpeg") return "JPG"
  if (mime === "image/webp") return "WebP"
  return null
}

function formatAvatarSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

interface AvatarUpload {
  name: string
  meta: string
  objectUrl: string
  status: "uploading" | "error"
  message?: string
}

function ProfilePage() {
  const { session } = appRouteApi.useRouteContext()
  const { edit } = useSearch({ from: "/_app/profile" })
  const navigate = useNavigate()
  const live = authClient.useSession().data?.user
  const user = live
    ? {
        name: live.name,
        firstName: live.firstName ?? "",
        lastName: live.lastName ?? "",
        email: live.email,
      }
    : {
        name: session.name,
        firstName: session.firstName,
        lastName: session.lastName,
        email: session.email,
        avatarUrl: undefined as string | undefined,
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

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<AvatarUpload | null>(null)

  async function handleAvatarFile(file: File | undefined) {
    if (!file) return
    const kind = avatarKindLabel(file.type)
    if (!kind) {
      setUpload({
        name: file.name,
        meta: "",
        objectUrl: URL.createObjectURL(file),
        status: "error",
        message: "Solo se admiten PNG, JPG o WebP",
      })
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setUpload({
        name: file.name,
        meta: `${kind} · ${formatAvatarSize(file.size)}`,
        objectUrl: URL.createObjectURL(file),
        status: "error",
        message: "La imagen no puede superar 2 MB",
      })
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    const objectUrl = URL.createObjectURL(file)
    setUpload({
      name: file.name,
      meta: `${kind} · ${formatAvatarSize(file.size)}`,
      objectUrl,
      status: "uploading",
    })
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(`${API_URL}/api/uploads/avatar`, {
        method: "POST",
        credentials: "include",
        body: formData,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        setUpload((prev) =>
          prev
            ? { ...prev, status: "error", message: body?.error?.message ?? common.errors.generic }
            : prev,
        )
        return
      }
      const { data } = (await res.json()) as { data: { url: string } }
      const { error: updateError } = await authClient.updateUser({ image: data.url })
      if (updateError) {
        setUpload((prev) =>
          prev ? { ...prev, status: "error", message: common.errors.generic } : prev,
        )
        return
      }
      URL.revokeObjectURL(objectUrl)
      setUpload(null)
      toast.success("Foto actualizada")
    } catch {
      setUpload((prev) =>
        prev ? { ...prev, status: "error", message: common.errors.generic } : prev,
      )
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function handleRemovePhoto() {
    const { error: updateError } = await authClient.updateUser({ image: null })
    if (updateError) {
      toast.error(common.errors.generic)
      return
    }
    toast.success("Foto eliminada")
  }

  const initial = user.name.trim().charAt(0).toUpperCase() || "U"
  const avatar = user.avatarUrl ? (
    <img src={user.avatarUrl} alt={user.name} className="size-16 rounded-full object-cover" />
  ) : (
    <div className="flex size-16 items-center justify-center rounded-full bg-primary text-xl font-semibold text-primary-foreground">
      {initial}
    </div>
  )

  return (
    <PageShell className="flex max-w-2xl flex-col gap-6">
      <PageHeader title="Mi perfil" subtitle="Administra tu información de cuenta y seguridad" />
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Perfil</div>
          <p className="text-sm text-muted-foreground">Tu información personal en odentIA.</p>
        </div>
        <div>
          <div className="flex items-center gap-4">
            {avatar}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Cambiar foto
              </Button>
              {user.avatarUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRemovePhoto()}
                >
                  Quitar
                </Button>
              ) : null}
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => void handleAvatarFile(event.target.files?.[0])}
          />
          {upload ? (
            <Attachment state={upload.status} className="mt-4">
              <AttachmentMedia variant="image">
                <img src={upload.objectUrl} alt={upload.name} />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{upload.name}</AttachmentTitle>
                <AttachmentDescription>
                  {upload.status === "error"
                    ? (upload.message ?? common.errors.generic)
                    : upload.meta}
                </AttachmentDescription>
              </AttachmentContent>
              {upload.status === "error" ? (
                <AttachmentAction aria-label="Descartar" onClick={() => setUpload(null)}>
                  <XIcon />
                </AttachmentAction>
              ) : null}
            </Attachment>
          ) : null}
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
      <div className="flex flex-col gap-4">
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
      </div>
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
