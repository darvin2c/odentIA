import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  common,
  FormDrawer,
  groupedSecret,
  RECOMMENDED_AUTHENTICATORS,
  submitErrorMessage,
  submitForm,
  totpDigits,
  totpSecret,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, ChevronDown } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { authClient } from "../lib/auth-client"
import { type AuthErrorRoute, authError, authFormMessage } from "../lib/auth-error"
import { panelWords } from "../lib/brand"
import { totpQrDataUrl } from "../lib/totp"

/**
 * Verificación en dos pasos de la persona (ADR 0107): solo app autenticadora.
 * Activar, cambiar de teléfono, códigos nuevos y desactivar son de Better Auth;
 * lo que se dice de ella (quién la pide, navegadores recordados) sale de
 * `/api/account/two-factor`.
 */
export type TwoFactorEdit = "two-factor" | "two-factor-phone" | "two-factor-codes" | "two-factor-off"
export const TWO_FACTOR_EDITS: readonly TwoFactorEdit[] = ["two-factor", "two-factor-phone", "two-factor-codes", "two-factor-off"]

const statusSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    staff: z.boolean(),
    hasPassword: z.boolean(),
    requiredBy: z.array(z.string()),
    trustedBrowsers: z.number(),
  }),
})
type TwoFactorStatus = z.infer<typeof statusSchema>["data"]
export const TWO_FACTOR_KEY = ["account-two-factor"] as const

export function useTwoFactorStatus() {
  return useQuery({
    queryKey: TWO_FACTOR_KEY,
    queryFn: async () => statusSchema.parse(await apiFetch<unknown>("/api/account/two-factor")).data,
  })
}

/**
 * Lo que Better Auth rechaza en estos cajones: la contraseña y el código, en su
 * campo; lo demás (ya activa, la pide una clínica, demasiados intentos), junto
 * al botón.
 */
const TWO_FACTOR_ROUTE: AuthErrorRoute = {
  fields: { INVALID_PASSWORD: "password", INVALID_CODE: "code" },
  messages: {
    INVALID_CODE:
      "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático.",
  },
}

/** La contraseña solo se pide si la cuenta tiene una (quien entra con Google no). */
function passwordSchema(hasPassword: boolean) {
  return z.object({ password: hasPassword ? z.string().min(1, "Escribe tu contraseña.") : z.string() })
}

const codeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Escribe los 6 dígitos que muestra la app."),
})

const savedSchema = z.object({
  saved: z.boolean().refine((value) => value, "Marca la casilla cuando los hayas guardado."),
})

/** La fila de Seguridad en Mi perfil. */
export function TwoFactorRow() {
  const status = useTwoFactorStatus()
  const queryClient = useQueryClient()
  const forget = useMutation({
    mutationFn: () => apiFetch("/api/account/two-factor/forget-browsers", { method: "POST" }),
    onSuccess: async () => {
      toast.success("Listo: tus navegadores volverán a pedir el código")
      await queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  if (status.isPending) return <Skeleton className="h-16 w-full" />
  if (status.isError) return <p className="text-sm text-muted-foreground">No pudimos cargar tu verificación en dos pasos.</p>
  const value = status.data
  const badge = (
    <Badge variant={value.enabled ? "default" : "secondary"} className={value.enabled ? "bg-primary-soft text-primary-soft-foreground" : undefined}>
      {value.enabled ? "Activa" : "Apagada"}
    </Badge>
  )
  if (value.staff) {
    return (
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-sm font-medium">Verificación en dos pasos</p>
        <p className="text-sm text-muted-foreground">Es la de la administración: se maneja allí.</p>
      </div>
    )
  }
  if (!value.enabled) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex max-w-md flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-medium">Verificación en dos pasos {badge}</p>
          <p className="text-sm text-muted-foreground">
            Al entrar te pediremos, además de tu contraseña, un código de 6 dígitos de una app de tu teléfono. Si alguien consigue tu contraseña, sin tu teléfono no entra.
          </p>
          {value.requiredBy.length > 0 ? (
            <p className="text-sm font-medium text-foreground">{value.requiredBy.join(", ")} la pide a su equipo.</p>
          ) : null}
        </div>
        <Button render={<Link to="/profile" search={{ edit: "two-factor" }} />} className="self-start">
          Activar
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm font-medium">Verificación en dos pasos {badge}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">La pide</dt>
          <dd className="font-medium">{value.requiredBy.length > 0 ? value.requiredBy.join(", ") : "Ninguna de tus clínicas: la activaste tú"}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Navegadores que no piden el código</dt>
          <dd className="font-medium">{value.trustedBrowsers === 0 ? "Ninguno" : value.trustedBrowsers === 1 ? "1, hasta 30 días" : `${value.trustedBrowsers}, hasta 30 días`}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" render={<Link to="/profile" search={{ edit: "two-factor-phone" }} />}>
          Cambiar de teléfono
        </Button>
        <Button variant="outline" render={<Link to="/profile" search={{ edit: "two-factor-codes" }} />}>
          Nuevos códigos de respaldo
        </Button>
        {value.trustedBrowsers > 0 ? (
          <Button type="button" variant="outline" disabled={forget.isPending} onClick={() => forget.mutate()}>
            Que vuelvan a pedir el código
          </Button>
        ) : null}
        {value.requiredBy.length > 0 ? (
          <Button type="button" variant="outline" disabled aria-describedby="two-factor-kept">
            Desactivar
          </Button>
        ) : (
          <Button variant="outline" render={<Link to="/profile" search={{ edit: "two-factor-off" }} />}>
            Desactivar
          </Button>
        )}
      </div>
      {value.requiredBy.length > 0 ? (
        <p id="two-factor-kept" className="text-sm text-muted-foreground">
          No puedes desactivarla: {value.requiredBy.join(", ")} la pide a su equipo. Si cambias de teléfono, usa «Cambiar de teléfono».
        </p>
      ) : null}
    </div>
  )
}

/** Las apps que se recomiendan, plegadas para no estorbar a quien ya tiene una. */
function RecommendedApps() {
  return (
    <Collapsible className="flex flex-col gap-2 rounded-xl border px-4 py-3">
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" className="group h-auto justify-between px-0 text-foreground hover:bg-transparent aria-expanded:bg-transparent" />}
      >
        ¿Aún no tienes una app? Te recomendamos estas
        <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">{RECOMMENDED_AUTHENTICATORS.join(" o ")}</strong>: gratis, en Android y iPhone, y guardan copia en tu cuenta. Si cambias de teléfono, no pierdes el acceso.
          </li>
          <li>¿Ya usas un gestor de contraseñas (1Password, Bitwarden)? También sirve.</li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** El QR (o la clave a mano) de un enlace `otpauth://`. */
function ScanCode({ uri }: { uri: string }) {
  const [qr, setQr] = useState<string | null>(null)
  const secret = groupedSecret(totpSecret(uri))
  useEffect(() => {
    let alive = true
    void totpQrDataUrl(uri).then((url) => {
      if (alive) setQr(url)
    })
    return () => {
      alive = false
    }
  }, [uri])
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="size-44 shrink-0 rounded-xl border bg-white p-1.5">
        {qr ? <img src={qr} alt={`Código QR para agregar ${panelWords.name} a tu app`} className="size-full" /> : <div className="size-full animate-pulse rounded-lg bg-muted" />}
      </div>
      <div className="flex min-w-0 flex-col gap-2 text-sm text-muted-foreground">
        <span>¿No puedes escanear? Escribe esta clave en la app («Ingresar una clave», tipo «Basada en el tiempo»):</span>
        <code className="rounded-lg bg-muted px-3 py-2 font-mono text-[15px] tracking-[0.06em] text-foreground">{secret}</code>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => {
            void navigator.clipboard
              .writeText(secret.replace(/\s/g, ""))
              .then(() => toast.success("Copiado"))
              .catch(() => toast.error("No se pudo copiar: selecciónala y cópiala a mano"))
          }}
        >
          Copiar la clave
        </Button>
        <a href={uri} className="font-medium text-primary sm:hidden">
          Estoy en el teléfono: abrir en mi app
        </a>
      </div>
    </div>
  )
}

/** La casilla «Los guardé…» va como `children`: es el campo del formulario del cajón. */
function BackupCodes({ email, codes, children }: { email: string; codes: string[]; children: ReactNode }) {
  const text = [`Códigos de respaldo de ${panelWords.name}`, `Cuenta: ${email}`, "", "Cada código sirve una sola vez. Úsalo si no tienes tu app de autenticación.", "", ...codes, ""].join("\n")
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${panelWords.name.toLowerCase()}-codigos-de-respaldo.txt`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Son tu llave de emergencia. Si pierdes el teléfono, entras con uno de estos en vez del código de la app. Cada uno sirve una sola vez y no los volveremos a mostrar.
      </p>
      <ul aria-label="Códigos de respaldo" className="grid grid-cols-2 gap-2 rounded-xl border p-3">
        {codes.map((code) => (
          <li key={code} className="rounded-md bg-muted px-2 py-1.5 text-center font-mono text-[15px] tracking-[0.04em]">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={download}>
          Descargar (.txt)
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(codes.join("\n"))
              .then(() => toast.success("Copiado"))
              .catch(() => toast.error("No se pudo copiar: selecciónalos y cópialos a mano"))
          }}
        >
          Copiar
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Guárdalos donde no esté tu teléfono: un gestor de contraseñas o impresos.</p>
      {children}
    </div>
  )
}

const SAVED_LABEL = "Los guardé en un lugar seguro"
const SAVED_HELP = "«Terminar» te pide marcarla: no los volveremos a mostrar."
const GOOGLE_ONLY = "Entras con Google: no hace falta tu contraseña."

/** Activar (pasos: contraseña → escanear y confirmar → códigos de respaldo). */
export function TwoFactorSetupDrawer({
  open,
  email,
  status,
  onClose,
}: {
  open: boolean
  email: string
  status: TwoFactorStatus | undefined
  /** `activated`: cerró ya activada (tras guardar los códigos). */
  onClose: (activated: boolean) => void
}) {
  const queryClient = useQueryClient()
  const hasPassword = Boolean(status?.hasPassword)
  const [enroll, setEnroll] = useState<{ uri: string; codes: string[] } | null>(null)
  const [step, setStep] = useState<"password" | "scan" | "codes">("password")

  const passwordForm = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema(hasPassword) },
    onSubmit: async ({ value }) => {
      const { data, error } = await authClient.twoFactor.enable({ password: hasPassword ? value.password : "", method: "totp" })
      if (error) throw authError(error, TWO_FACTOR_ROUTE)
      if (data?.method !== "totp") throw new Error(common.errors.generic)
      setEnroll({ uri: data.totpURI, codes: data.backupCodes ?? [] })
      setStep("scan")
    },
  })
  const codeForm = useAppForm({
    defaultValues: { code: "" },
    validators: { onSubmit: codeSchema },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.twoFactor.verifyTotp({ code: value.code })
      if (error) throw authError(error, TWO_FACTOR_ROUTE)
      toast.success("Verificación en dos pasos activada")
      setStep("codes")
    },
  })
  const savedForm = useAppForm({
    defaultValues: { saved: false },
    validators: { onSubmit: savedSchema },
    onSubmit: () => close(),
  })
  const passwordSurface = useFormSurface(passwordForm, { formMessage: authFormMessage })
  const codeSurface = useFormSurface(codeForm, { formMessage: authFormMessage })
  const savedSurface = useFormSurface(savedForm)
  const saved = useStore(savedForm.store, (state) => state.values.saved)

  const reset = () => {
    passwordForm.reset()
    codeForm.reset()
    savedForm.reset()
    setEnroll(null)
    setStep("password")
  }
  // Cerrar mientras se envía lo impide el cajón (`isSubmitting`).
  const close = () => {
    const finished = step === "codes"
    reset()
    if (finished) void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY })
    onClose(finished)
  }

  // Llegó con el enlace de una clínica pero ya la tiene (o es del personal): no
  // se vuelve a activar; si ya la tiene, «Listo» lo devuelve a la clínica.
  if (step === "password" && status && (status.enabled || status.staff)) {
    return (
      <FormDrawer
        open={open}
        onClose={() => onClose(false)}
        title="Verificación en dos pasos"
        description={status.staff ? "Es la de la administración: se maneja allí." : "Ya la tienes activa."}
        onSubmit={(event) => {
          event.preventDefault()
          onClose(status.enabled)
        }}
        submitLabel="Listo"
      >
        <p className="text-sm text-muted-foreground">
          {status.staff
            ? "Tu verificación es la misma que usas en la administración."
            : "Si una clínica te la pide, al volver escribe el código de tu app."}
        </p>
      </FormDrawer>
    )
  }
  const title = step === "codes" ? "Guarda tus códigos de respaldo" : "Activar la verificación en dos pasos"
  const description =
    step === "password"
      ? "Paso 1 de 3 · tarda un par de minutos. Hasta que confirmes el código, nada cambia al entrar."
      : step === "scan"
        ? "Paso 2 de 3"
        : "Paso 3 de 3: ya está activa."
  const surface = step === "password" ? passwordSurface : step === "scan" ? codeSurface : savedSurface

  return (
    <FormDrawer
      {...surface}
      // Escaneando ya hay una clave a medias; con los códigos a la vista, falta guardarlos.
      isDirty={step === "scan" || (step === "codes" ? !saved : surface.isDirty)}
      open={open}
      onClose={close}
      title={title}
      description={description}
      submitLabel={step === "password" ? "Continuar" : step === "scan" ? "Activar" : "Terminar"}
    >
      {step === "password" ? (
        <div className="flex flex-col gap-4">
          {hasPassword ? (
            <passwordForm.AppField name="password">
              {(field) => <field.PasswordField id="two-factor-password" label="Tu contraseña" autoComplete="current-password" autoFocus />}
            </passwordForm.AppField>
          ) : (
            <p className="text-sm text-muted-foreground">{GOOGLE_ONLY}</p>
          )}
          <RecommendedApps />
        </div>
      ) : step === "scan" && enroll ? (
        <div className="flex flex-col gap-5">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Check aria-hidden className="size-4 text-primary" /> Confirmaste tu contraseña
          </p>
          <RecommendedApps />
          <p className="text-sm">Abre la app, toca «+» y escanea:</p>
          <ScanCode uri={enroll.uri} />
          <codeForm.AppField name="code">
            {(field) => (
              <field.Control
                id="two-factor-code"
                label="Escribe el código de 6 dígitos que muestra la app"
                description="Cambia cada 30 segundos. Al escribir el sexto número se confirma solo."
              >
                {(control) => (
                  <Input
                    {...control.props}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    value={field.state.value}
                    onChange={(event) => {
                      const next = totpDigits(event.target.value)
                      field.handleChange(next)
                      // El sexto número confirma solo, como dice la ayuda.
                      if (next.length === 6 && !codeForm.state.isSubmitting) void submitForm(codeForm, { formMessage: authFormMessage })
                    }}
                    className="h-12 font-mono text-2xl tracking-[0.4em]"
                  />
                )}
              </field.Control>
            )}
          </codeForm.AppField>
        </div>
      ) : enroll ? (
        <BackupCodes email={email} codes={enroll.codes}>
          <savedForm.AppField name="saved">
            {(field) => <field.CheckboxField id="codes-saved" label={SAVED_LABEL} description={SAVED_HELP} />}
          </savedForm.AppField>
        </BackupCodes>
      ) : null}
    </FormDrawer>
  )
}

/**
 * Cambiar de teléfono: la misma clave, para agregarla en el teléfono nuevo.
 * No cambia nada guardado: el teléfono anterior sigue sirviendo hasta que la
 * persona lo borre de su app, y nadie queda fuera si deja esto a medias.
 */
export function TwoFactorPhoneDrawer({ open, status, onClose }: { open: boolean; status: TwoFactorStatus | undefined; onClose: () => void }) {
  const hasPassword = Boolean(status?.hasPassword)
  const [uri, setUri] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema(hasPassword) },
    onSubmit: async ({ value }) => {
      const { data, error } = await authClient.twoFactor.getTotpUri({ password: hasPassword ? value.password : "" })
      if (error) throw authError(error, TWO_FACTOR_ROUTE)
      if (!data?.totpURI) throw new Error(common.errors.generic)
      setUri(data.totpURI)
    },
  })
  const surface = useFormSurface(form, { formMessage: authFormMessage })
  const close = () => {
    form.reset()
    setUri(null)
    onClose()
  }
  return (
    <FormDrawer
      {...(uri
        ? {
            // La clave ya está a la vista: «Listo» solo cierra.
            onSubmit: (event: FormEvent) => {
              event.preventDefault()
              close()
            },
          }
        : surface)}
      open={open}
      onClose={close}
      title="Cambiar de teléfono"
      description={uri ? "Escanéalo con la app del teléfono nuevo." : "Te mostramos la misma clave para agregarla en el teléfono nuevo."}
      submitLabel={uri ? "Listo" : "Mostrar la clave"}
    >
      {uri ? (
        <div className="flex flex-col gap-4">
          <ScanCode uri={uri} />
          <p className="text-sm text-muted-foreground">
            Si tu app guarda copia en tu cuenta ({RECOMMENDED_AUTHENTICATORS.join(" o ")}), en el teléfono nuevo basta con entrar a la app con tu cuenta. Cuando el nuevo muestre el código, puedes borrarlo del anterior.
          </p>
        </div>
      ) : hasPassword ? (
        <form.AppField name="password">
          {(field) => <field.PasswordField id="two-factor-password" label="Tu contraseña" autoComplete="current-password" autoFocus />}
        </form.AppField>
      ) : (
        <p className="text-sm text-muted-foreground">{GOOGLE_ONLY}</p>
      )}
    </FormDrawer>
  )
}

/** Códigos de respaldo nuevos: anulan los anteriores. */
export function TwoFactorCodesDrawer({ open, email, status, onClose }: { open: boolean; email: string; status: TwoFactorStatus | undefined; onClose: () => void }) {
  const hasPassword = Boolean(status?.hasPassword)
  const [codes, setCodes] = useState<string[] | null>(null)
  const passwordForm = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema(hasPassword) },
    onSubmit: async ({ value }) => {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({ password: hasPassword ? value.password : "" })
      if (error) throw authError(error, TWO_FACTOR_ROUTE)
      if (!data?.backupCodes) throw new Error(common.errors.generic)
      setCodes(data.backupCodes)
    },
  })
  const savedForm = useAppForm({
    defaultValues: { saved: false },
    validators: { onSubmit: savedSchema },
    onSubmit: () => close(),
  })
  const passwordSurface = useFormSurface(passwordForm, { formMessage: authFormMessage })
  const savedSurface = useFormSurface(savedForm)
  // Cerrar mientras se envía lo impide el cajón (`isSubmitting`).
  const close = () => {
    passwordForm.reset()
    savedForm.reset()
    setCodes(null)
    onClose()
  }
  return (
    <FormDrawer
      {...(codes ? savedSurface : passwordSurface)}
      open={open}
      onClose={close}
      title="Nuevos códigos de respaldo"
      description={codes ? "Los anteriores ya no sirven." : "Al pedirlos, los anteriores dejan de servir."}
      submitLabel={codes ? "Terminar" : "Pedir códigos nuevos"}
    >
      {codes ? (
        <BackupCodes email={email} codes={codes}>
          <savedForm.AppField name="saved">
            {(field) => <field.CheckboxField id="codes-saved" label={SAVED_LABEL} description={SAVED_HELP} />}
          </savedForm.AppField>
        </BackupCodes>
      ) : hasPassword ? (
        <passwordForm.AppField name="password">
          {(field) => <field.PasswordField id="two-factor-password" label="Tu contraseña" autoComplete="current-password" autoFocus />}
        </passwordForm.AppField>
      ) : (
        <p className="text-sm text-muted-foreground">{GOOGLE_ONLY}</p>
      )}
    </FormDrawer>
  )
}

/**
 * Desactivar: solo si ninguna de sus clínicas la pide (el servidor también lo
 * exige). Si alguna la pide, el cajón no se abre, tampoco con el enlace.
 */
export function TwoFactorOffDrawer({ open, status, onClose }: { open: boolean; status: TwoFactorStatus | undefined; onClose: () => void }) {
  const queryClient = useQueryClient()
  const hasPassword = Boolean(status?.hasPassword)
  const form = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema(hasPassword) },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.twoFactor.disable({ password: hasPassword ? value.password : "" })
      if (error) throw authError(error, TWO_FACTOR_ROUTE)
      toast.success("Verificación en dos pasos desactivada")
      await queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY })
      close()
    },
  })
  const surface = useFormSurface(form, { formMessage: authFormMessage })
  const close = () => {
    form.reset()
    onClose()
  }
  return (
    <FormDrawer
      {...surface}
      open={open && status?.requiredBy.length === 0}
      onClose={close}
      title="Desactivar la verificación en dos pasos"
      description="Al entrar bastará tu contraseña. Tu app y tus códigos de respaldo dejan de servir."
      submitLabel="Desactivar"
    >
      {hasPassword ? (
        <form.AppField name="password">
          {(field) => <field.PasswordField id="two-factor-password" label="Tu contraseña" autoComplete="current-password" autoFocus />}
        </form.AppField>
      ) : (
        <p className="text-sm text-muted-foreground">{GOOGLE_ONLY}</p>
      )}
    </FormDrawer>
  )
}
