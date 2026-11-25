import { Badge, Button, FieldGroup, Separator, toast } from "@odentia/ui"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Monitor, Smartphone } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { common } from "../common.js"
import { ConfirmDialog } from "../confirm-dialog.js"
import { ErrorState } from "../error-state.js"
import { useAppForm, useFormSurface } from "../form/app-form.js"
import { FormDrawer } from "../form/form-drawer.js"
import { submitErrorMessage } from "../form/submit-error.js"
import { ImageAdjust, type ImageAdjustValue, renderAdjustedImage } from "../image-adjust.js"
import { SkeletonRegion } from "../loading-state.js"
import { PageHeader } from "../page-header.js"
import { PageShell } from "../page-shell.js"
import { PASSWORD_MIN_LENGTH, usePasswordRequirements } from "../password-requirements.js"
import { PersonAvatar } from "../person-avatar.js"
import { AUTH_NETWORK, authError, authErrorMessage, authFormMessage } from "./auth-error.js"
import { editSearch, useAccount, useAccountFetch } from "./context.js"
import { SessionsSkeleton } from "./skeletons.js"
import {
  TWO_FACTOR_EDITS,
  TwoFactorCodesDrawer,
  type TwoFactorEdit,
  TwoFactorOffDrawer,
  TwoFactorPhoneDrawer,
  TwoFactorRow,
  TwoFactorSetupDrawer,
  useTwoFactorStatus,
} from "./two-factor.js"
import { parseUserAgent, relativeTime } from "./user-agent.js"

/** El cajón abierto de Mi perfil (`?edit=`). */
export type AccountProfileEdit = "profile" | "password" | "email" | TwoFactorEdit

export function isAccountProfileEdit(value: unknown): value is AccountProfileEdit {
  return (
    value === "profile" ||
    value === "password" ||
    value === "email" ||
    TWO_FACTOR_EDITS.includes(value as TwoFactorEdit)
  )
}

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
  file: z.custom<ImageAdjustValue | null>(
    (value) => value !== null,
    "Elige una imagen y encuádrala.",
  ),
})

export interface AccountProfileUser {
  name: string
  firstName: string
  lastName: string
  email: string
  image: string | null
}

/** Cerrar la cuenta: lo que dice en cada app y lo que pasa después. */
export interface AccountCloseOptions {
  /** Qué pasa al cerrarla, en la tarjeta («Sales de tus clínicas…»). */
  description: string
  /** La frase del diálogo que confirma. */
  confirm: string
  /**
   * Lo que impide cerrarla todavía, dicho en la tarjeta (ser el único Dueño de una tienda). Con
   * él, el botón no abre el diálogo: primero hay que resolverlo.
   */
  blocker?: ReactNode
  /** Ya cerrada: la app cierra la sesión y lleva a la entrada. */
  onClosed: () => Promise<void> | void
}

export interface AccountProfilePageProps {
  /** El cajón abierto (`?edit=`). */
  edit?: AccountProfileEdit
  /** Cierra el cajón (vuelve a Mi perfil sin `edit`). */
  onCloseEdit: () => void
  /** Tras activar los dos pasos: la app vuelve adonde se los pidieron, si hay adónde. */
  onTwoFactorActivated?: () => void
  /** La persona mientras la sesión del cliente no llega (la del enrutador). */
  fallbackUser?: AccountProfileUser
  /** Lo que va sobre el título (volver a la clínica o a la tienda). */
  back?: ReactNode
  /** «Tu información personal en odentIA.» */
  profileDescription: string
  /** Lo propio de cada app entre las sesiones y cerrar la cuenta (sus clínicas, sus invitaciones). */
  children?: ReactNode
  close: AccountCloseOptions
}

/**
 * La foto de Mi perfil con «Ajustar imagen» (tablero 6): se encuadra y se sube
 * ya recortada. «Cancelar» deja la anterior; guardar la pone en la cuenta y
 * desde ahí la ven todas las apps y este perfil. El dato se llama `file`, como
 * en el cuerpo de la subida: lo que rechace el servidor (formato, peso) se dice
 * junto a la imagen.
 */
function ProfilePhotoDrawer({
  open,
  name,
  onClose,
}: {
  open: boolean
  name: string
  onClose: () => void
}) {
  const { client, onPersonChanged } = useAccount()
  const request = useAccountFetch()
  const form = useAppForm({
    defaultValues: { file: null as ImageAdjustValue | null },
    validators: { onSubmit: photoSchema },
    onSubmit: async ({ value }) => {
      if (!value.file) return
      const { blob, ext } = await renderAdjustedImage(value.file)
      const formData = new FormData()
      formData.append("file", blob, `avatar.${ext}`)
      const { data } = await request<{ data: { url: string } }>("/api/uploads/avatar", {
        method: "POST",
        body: formData,
      })
      const { error: updateError } = await client.updateUser({ image: data.url })
      if (updateError) throw authError(updateError)
      form.reset()
      onPersonChanged?.()
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

/**
 * Mi perfil, la misma en todas las apps (ADR 0218): la persona, su seguridad, sus sesiones, lo
 * propio de cada app y cerrar la cuenta. Los cajones se abren con `?edit=` en la dirección.
 */
export function AccountProfilePage({
  edit,
  onCloseEdit,
  onTwoFactorActivated,
  fallbackUser,
  back,
  profileDescription,
  children,
  close,
}: AccountProfilePageProps) {
  const { client, profilePath, onPersonChanged } = useAccount()
  const twoFactor = useTwoFactorStatus()
  const live = client.useSession().data?.user
  // La foto sale de la cuenta (`image`), la misma que ven las demás apps.
  const user: AccountProfileUser = live
    ? {
        name: live.name,
        firstName: live.firstName ?? "",
        lastName: live.lastName ?? "",
        email: live.email,
        image: live.image ?? null,
      }
    : (fallbackUser ?? { name: "", firstName: "", lastName: "", email: "", image: null })

  const [photoOpen, setPhotoOpen] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function handleRemovePhoto() {
    setRemoving(true)
    try {
      const { error: updateError } = await client.updateUser({ image: null })
      if (updateError) {
        toast.error(authErrorMessage(updateError))
        return
      }
      onPersonChanged?.()
      toast.success("Foto quitada")
    } catch {
      toast.error(AUTH_NETWORK)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <PageShell className="flex max-w-2xl flex-col gap-6">
      {back}
      <PageHeader title="Mi perfil" subtitle="Administra tu información de cuenta y seguridad" />
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Perfil</div>
          <p className="text-sm text-muted-foreground">{profileDescription}</p>
        </div>
        <div>
          <div className="flex items-center gap-4">
            <PersonAvatar
              name={user.name}
              givenNames={user.firstName}
              familyName={user.lastName}
              src={user.image}
              className="size-16"
              fallbackClassName="text-lg"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </div>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setPhotoOpen(true)}>
                {user.image ? "Cambiar foto" : "Subir foto"}
              </Button>
              {user.image ? (
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
          <ProfilePhotoDrawer
            open={photoOpen}
            name={user.name}
            onClose={() => setPhotoOpen(false)}
          />
          <Separator className="my-2" />
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">Nombre</p>
              <p className="text-sm text-muted-foreground">
                {`${user.firstName} ${user.lastName}`.trim() || user.name}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              render={<Link to={profilePath} search={editSearch("profile")} />}
            >
              Editar
            </Button>
          </div>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">Correo</p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              render={<Link to={profilePath} search={editSearch("email")} />}
            >
              Cambiar
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Seguridad</div>
          <p className="text-sm text-muted-foreground">
            Tu contraseña y la verificación en dos pasos.
          </p>
        </div>
        <div>
          <Button
            variant="outline"
            render={<Link to={profilePath} search={editSearch("password")} />}
          >
            Cambiar contraseña
          </Button>
        </div>
        <Separator />
        <TwoFactorRow />
      </div>
      <SessionsCard />
      {children}
      <CloseAccountCard {...close} />
      <EditProfileDrawer
        key={`${user.firstName}|${user.lastName}`}
        open={edit === "profile"}
        initialFirstName={user.firstName}
        initialLastName={user.lastName}
        onClose={onCloseEdit}
      />
      <ChangePasswordDrawer open={edit === "password"} onClose={onCloseEdit} />
      <TwoFactorSetupDrawer
        open={edit === "two-factor"}
        email={user.email}
        status={twoFactor.data}
        onClose={(activated) => {
          // Activada desde el lugar que la pide: de vuelta a él.
          if (activated && onTwoFactorActivated) onTwoFactorActivated()
          else onCloseEdit()
        }}
      />
      <TwoFactorPhoneDrawer
        open={edit === "two-factor-phone"}
        status={twoFactor.data}
        onClose={onCloseEdit}
      />
      <TwoFactorCodesDrawer
        open={edit === "two-factor-codes"}
        email={user.email}
        status={twoFactor.data}
        onClose={onCloseEdit}
      />
      <TwoFactorOffDrawer
        open={edit === "two-factor-off"}
        status={twoFactor.data}
        onClose={onCloseEdit}
      />
      <ChangeEmailDrawer
        key={user.email}
        open={edit === "email"}
        currentEmail={user.email}
        onClose={onCloseEdit}
      />
    </PageShell>
  )
}

function SessionsCard() {
  const { client } = useAccount()
  const queryClient = useQueryClient()
  const currentToken = client.useSession().data?.session.token
  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await client.listSessions()
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
          ? await client.revokeSession({ token: revokeTarget.token })
          : await client.revokeOtherSessions()
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
  const { client, onPersonChanged } = useAccount()
  const form = useAppForm({
    defaultValues: { firstName: initialFirstName, lastName: initialLastName },
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      const firstName = value.firstName.trim()
      const lastName = value.lastName.trim()
      const { error } = await client.updateUser({
        name: `${firstName} ${lastName}`.trim(),
        firstName,
        lastName,
      })
      if (error) throw authError(error)
      onPersonChanged?.()
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
          {(field) => (
            <field.TextField
              id="profile-first-name"
              label="Nombre"
              type="text"
              autoComplete="given-name"
            />
          )}
        </form.AppField>
        <form.AppField name="lastName">
          {(field) => (
            <field.TextField
              id="profile-last-name"
              label="Apellidos"
              type="text"
              autoComplete="family-name"
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

function ChangePasswordDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { client } = useAccount()
  const form = useAppForm({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      const { error } = await client.changePassword({
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
      description="Es la de tu cuenta: vale para todas tus apps. Al cambiarla, se cierra tu cuenta en los otros navegadores y en las otras apps de este; aquí sigues adentro."
      onClose={close}
    >
      <FieldGroup>
        <form.AppField name="currentPassword">
          {(field) => (
            <field.PasswordField
              id="password-current"
              label="Contraseña actual"
              autoComplete="current-password"
            />
          )}
        </form.AppField>
        <form.AppField name="newPassword">
          {(field) => (
            <field.PasswordField
              id="password-new"
              label="Nueva contraseña"
              autoComplete="new-password"
              requirements={requirements}
            />
          )}
        </form.AppField>
        <form.AppField name="confirmPassword">
          {(field) => (
            <field.PasswordField
              id="password-confirm"
              label="Confirma la nueva contraseña"
              autoComplete="new-password"
            />
          )}
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
  const { client, profilePath, emailExample } = useAccount()
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
      const { error } = await client.changeEmail({
        newEmail: value.email.trim(),
        callbackURL: `${window.location.origin}${profilePath}`,
      })
      if (error)
        throw authError(error, {
          fields: { INVALID_EMAIL: "email" },
          messages: { INVALID_EMAIL: `Escribe un correo válido, como ${emailExample}` },
        })
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
        {(field) => (
          <field.TextField
            id="profile-email"
            label="Nuevo correo"
            type="email"
            autoComplete="email"
          />
        )}
      </form.AppField>
    </FormDrawer>
  )
}

function CloseAccountCard({ description, confirm, blocker, onClosed }: AccountCloseOptions) {
  const request = useAccountFetch()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClose() {
    setPending(true)
    setError(null)
    try {
      await request("/api/account/close", {
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
    await onClosed()
    setPending(false)
  }

  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border border-destructive/30 bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Cerrar cuenta</div>
        <p className="text-sm text-muted-foreground">{description}</p>
        {blocker}
      </div>
      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={Boolean(blocker)}
          aria-describedby={blocker ? CLOSE_ACCOUNT_BLOCKER_ID : undefined}
          onClick={() => setOpen(true)}
        >
          Cerrar mi cuenta
        </Button>
      </div>
      <ConfirmDialog
        open={open && !blocker}
        title="Cerrar tu cuenta"
        description={confirm}
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

/** El id que lleva lo que impide cerrar la cuenta: el botón lo nombra con `aria-describedby`. */
export const CLOSE_ACCOUNT_BLOCKER_ID = "cerrar-cuenta-antes"
