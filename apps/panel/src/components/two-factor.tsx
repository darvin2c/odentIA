import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  toast,
} from "@odentia/ui"
import {
  common,
  FormDrawer,
  groupedSecret,
  PasswordInput,
  RECOMMENDED_AUTHENTICATORS,
  totpDigits,
  totpSecret,
} from "@odentia/ui-patterns"
import { TwoFactorSkeleton } from "./skeletons/profile"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, ChevronDown } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { authClient } from "../lib/auth-client"
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

/** El error de Better Auth dicho para la persona. */
function authMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return common.errors.generic
  if (error.code === "INVALID_PASSWORD") return "Esa no es tu contraseña."
  if (error.code === "INVALID_CODE" || error.code === "INVALID_TWO_FACTOR_AUTHENTICATION")
    return "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático."
  if (error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" || error.code === "TOO_MANY_REQUESTS")
    return "Demasiados intentos: espera unos minutos e intenta de nuevo."
  return error.message || common.errors.generic
}

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
    onError: () => toast.error(common.errors.generic),
  })
  if (status.isPending) return <TwoFactorSkeleton />
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

function PasswordField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: string | null }) {
  return (
    <Field>
      <FieldLabel htmlFor="two-factor-password">Tu contraseña</FieldLabel>
      <PasswordInput
        id="two-factor-password"
        value={value}
        onChange={onChange}
        autoComplete="current-password"
        invalid={Boolean(error)}
        describedBy={error ? "two-factor-password-error" : undefined}
        autoFocus
      />
      {error ? <FieldError id="two-factor-password-error">{error}</FieldError> : null}
    </Field>
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

function CodeField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: string | null }) {
  return (
    <Field>
      <FieldLabel htmlFor="two-factor-code">Escribe el código de 6 dígitos que muestra la app</FieldLabel>
      <Input
        id="two-factor-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="000000"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "two-factor-code-error" : "two-factor-code-help"}
        onChange={(event) => onChange(totpDigits(event.target.value))}
        className="h-12 font-mono text-2xl tracking-[0.4em]"
      />
      {error ? (
        <FieldError id="two-factor-code-error">{error}</FieldError>
      ) : (
        <FieldDescription id="two-factor-code-help">Cambia cada 30 segundos. Al escribir el sexto número se confirma solo.</FieldDescription>
      )}
    </Field>
  )
}

function BackupCodes({ email, codes, saved, onSaved }: { email: string; codes: string[]; saved: boolean; onSaved: (saved: boolean) => void }) {
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
      <label htmlFor="codes-saved" className="flex items-center gap-2.5 text-sm font-semibold">
        <Checkbox id="codes-saved" checked={saved} onCheckedChange={(checked) => onSaved(checked === true)} />
        Los guardé en un lugar seguro
      </label>
    </div>
  )
}

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
  const [password, setPassword] = useState("")
  const [enroll, setEnroll] = useState<{ uri: string; codes: string[] } | null>(null)
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"password" | "scan" | "codes">("password")
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setPassword("")
    setEnroll(null)
    setCode("")
    setStep("password")
    setSaved(false)
    setError(null)
  }
  const close = () => {
    if (busy) return
    const finished = step === "codes"
    reset()
    if (finished) void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY })
    onClose(finished)
  }

  async function start() {
    setBusy(true)
    setError(null)
    const { data, error: failed } = await authClient.twoFactor.enable({ password: status?.hasPassword ? password : "", method: "totp" })
    setBusy(false)
    if (failed || data?.method !== "totp") {
      setError(authMessage(failed))
      return
    }
    setEnroll({ uri: data.totpURI, codes: data.backupCodes ?? [] })
    setStep("scan")
  }

  async function confirm(value: string) {
    if (busy || value.length < 6) return
    setBusy(true)
    setError(null)
    const { error: failed } = await authClient.twoFactor.verifyTotp({ code: value })
    setBusy(false)
    if (failed) {
      setError(authMessage(failed))
      return
    }
    toast.success("Verificación en dos pasos activada")
    setStep("codes")
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

  return (
    <FormDrawer
      open={open}
      onClose={close}
      title={title}
      description={description}
      onSubmit={(event) => {
        event.preventDefault()
        if (step === "password") void start()
        else if (step === "scan") void confirm(code)
        else close()
      }}
      isDirty={step === "scan" || (step === "password" && password.length > 0) || (step === "codes" && !saved)}
      isSubmitting={busy}
      submitDisabled={step === "password" ? Boolean(status?.hasPassword) && password.length === 0 : step === "scan" ? code.length < 6 : !saved}
      submitLabel={step === "password" ? "Continuar" : step === "scan" ? "Activar" : "Terminar"}
      error={step === "scan" ? null : error}
    >
      {step === "password" ? (
        <div className="flex flex-col gap-4">
          {status?.hasPassword ? (
            <PasswordField value={password} onChange={setPassword} error={error} />
          ) : (
            <p className="text-sm text-muted-foreground">Entras con Google: no hace falta tu contraseña.</p>
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
          <CodeField
            value={code}
            error={error}
            onChange={(value) => {
              setCode(value)
              if (error) setError(null)
              if (value.length === 6) void confirm(value)
            }}
          />
        </div>
      ) : enroll ? (
        <BackupCodes email={email} codes={enroll.codes} saved={saved} onSaved={setSaved} />
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
  const [password, setPassword] = useState("")
  const [uri, setUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    setPassword("")
    setUri(null)
    setError(null)
    onClose()
  }
  async function show() {
    setBusy(true)
    setError(null)
    const { data, error: failed } = await authClient.twoFactor.getTotpUri({ password: status?.hasPassword ? password : "" })
    setBusy(false)
    if (failed || !data?.totpURI) {
      setError(authMessage(failed))
      return
    }
    setUri(data.totpURI)
  }
  return (
    <FormDrawer
      open={open}
      onClose={close}
      title="Cambiar de teléfono"
      description={uri ? "Escanéalo con la app del teléfono nuevo." : "Te mostramos la misma clave para agregarla en el teléfono nuevo."}
      onSubmit={(event) => {
        event.preventDefault()
        if (uri) close()
        else void show()
      }}
      isSubmitting={busy}
      submitDisabled={!uri && Boolean(status?.hasPassword) && password.length === 0}
      submitLabel={uri ? "Listo" : "Mostrar la clave"}
      error={error}
    >
      {uri ? (
        <div className="flex flex-col gap-4">
          <ScanCode uri={uri} />
          <p className="text-sm text-muted-foreground">
            Si tu app guarda copia en tu cuenta ({RECOMMENDED_AUTHENTICATORS.join(" o ")}), en el teléfono nuevo basta con entrar a la app con tu cuenta. Cuando el nuevo muestre el código, puedes borrarlo del anterior.
          </p>
        </div>
      ) : status?.hasPassword ? (
        <PasswordField value={password} onChange={setPassword} error={null} />
      ) : (
        <p className="text-sm text-muted-foreground">Entras con Google: no hace falta tu contraseña.</p>
      )}
    </FormDrawer>
  )
}

/** Códigos de respaldo nuevos: anulan los anteriores. */
export function TwoFactorCodesDrawer({ open, email, status, onClose }: { open: boolean; email: string; status: TwoFactorStatus | undefined; onClose: () => void }) {
  const [password, setPassword] = useState("")
  const [codes, setCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (busy) return
    setPassword("")
    setCodes(null)
    setSaved(false)
    setError(null)
    onClose()
  }
  async function generate() {
    setBusy(true)
    setError(null)
    const { data, error: failed } = await authClient.twoFactor.generateBackupCodes({ password: status?.hasPassword ? password : "" })
    setBusy(false)
    if (failed || !data?.backupCodes) {
      setError(authMessage(failed))
      return
    }
    setCodes(data.backupCodes)
  }
  return (
    <FormDrawer
      open={open}
      onClose={close}
      title="Nuevos códigos de respaldo"
      description={codes ? "Los anteriores ya no sirven." : "Al pedirlos, los anteriores dejan de servir."}
      onSubmit={(event) => {
        event.preventDefault()
        if (codes) close()
        else void generate()
      }}
      isSubmitting={busy}
      submitDisabled={codes ? !saved : Boolean(status?.hasPassword) && password.length === 0}
      submitLabel={codes ? "Terminar" : "Pedir códigos nuevos"}
      error={codes ? null : error}
    >
      {codes ? (
        <BackupCodes email={email} codes={codes} saved={saved} onSaved={setSaved} />
      ) : status?.hasPassword ? (
        <PasswordField value={password} onChange={setPassword} error={error} />
      ) : (
        <p className="text-sm text-muted-foreground">Entras con Google: no hace falta tu contraseña.</p>
      )}
    </FormDrawer>
  )
}

/** Desactivar: solo si ninguna de sus clínicas la pide (el servidor también lo exige). */
export function TwoFactorOffDrawer({ open, status, onClose }: { open: boolean; status: TwoFactorStatus | undefined; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (busy) return
    setPassword("")
    setError(null)
    onClose()
  }
  async function disable() {
    setBusy(true)
    setError(null)
    const { error: failed } = await authClient.twoFactor.disable({ password: status?.hasPassword ? password : "" })
    setBusy(false)
    if (failed) {
      setError(authMessage(failed))
      return
    }
    toast.success("Verificación en dos pasos desactivada")
    await queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY })
    close()
  }
  return (
    <FormDrawer
      open={open}
      onClose={close}
      title="Desactivar la verificación en dos pasos"
      description="Al entrar bastará tu contraseña. Tu app y tus códigos de respaldo dejan de servir."
      onSubmit={(event) => {
        event.preventDefault()
        void disable()
      }}
      isSubmitting={busy}
      submitDisabled={Boolean(status?.hasPassword) && password.length === 0}
      submitLabel="Desactivar"
      error={status?.hasPassword ? null : error}
    >
      {status?.hasPassword ? (
        <PasswordField value={password} onChange={setPassword} error={error} />
      ) : (
        <p className="text-sm text-muted-foreground">Entras con Google: no hace falta tu contraseña.</p>
      )}
    </FormDrawer>
  )
}
