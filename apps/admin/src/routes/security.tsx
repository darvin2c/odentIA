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
import { Brand, ErrorState, LoadingState, PasswordInput, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Check, ChevronDown, Cloud, Smartphone } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { ApiError, api } from "../lib/api"
import { authClient } from "../lib/auth-client"
import { panelUrl } from "../lib/host"
import {
  AUTHENTICATOR_STORES,
  backupCodesText,
  groupedSecret,
  totpDigits,
  totpQrDataUrl,
  totpSecret,
} from "../lib/totp"

export const Route = createFileRoute("/security")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.invitation === "string" ? { invitation: search.invitation } : {}),
  }),
  component: SecurityPage,
})

interface AccessSession {
  actor: { userId: string; role: "admin" | "support" }
  user: { name: string; email: string; image: string | null }
  hasPassword: boolean
  enrolled: boolean
  verified: boolean
  method: "totp" | "recovery" | null
}

interface EnrollStart {
  totpURI: string
  backupCodes: string[]
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? `Error ${error.status}`
  return "No pudimos conectar. Lo que escribiste sigue aquí: intenta de nuevo."
}

function apiCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.shape.code : undefined
}

/** El error de un código, dicho junto al campo (tablero 6 del lienzo). */
function codeError(error: unknown, recovery = false): string {
  if (apiCode(error) === "MFA_INVALID") {
    return recovery
      ? "Ese código no existe o ya se usó."
      : "Ese código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos). Si sigue fallando, revisa que la hora del teléfono esté en automático."
  }
  return apiMessage(error)
}

/** Teléfono o tableta: no se puede escanear la propia pantalla (D9). */
function useTouchDevice(): boolean {
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)")
    setTouch(query.matches)
    const onChange = (event: MediaQueryListEvent) => setTouch(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return touch
}

async function signOut() {
  await authClient.signOut()
  window.location.assign(panelUrl("/login"))
}

/**
 * Seguridad de acceso (lienzo «Segundo factor de la administración», aprobado
 * el 2026-10-24): la primera vez, tres pasos —confirmar la contraseña,
 * escanear y escribir el código, guardar los códigos de respaldo—; después,
 * solo el código. No es una página pública: sin el lado de la marca.
 */
function SecurityPage() {
  const { invitation } = Route.useSearch()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const session = useQuery({
    queryKey: ["admin-access-session"],
    queryFn: () => api<AccessSession>("/api/admin/access/session"),
    retry: false,
  })
  const [enroll, setEnroll] = useState<EnrollStart | null>(null)
  // Recién activado: los códigos se muestran antes de entrar, aunque la sesión ya esté verificada.
  const [savedCodes, setSavedCodes] = useState<string[] | null>(null)

  const enter = async () => {
    setSavedCodes(null)
    setEnroll(null)
    await queryClient.invalidateQueries({ queryKey: ["admin-access-session"] })
    await navigate({ to: "/" })
  }
  const refresh = () => {
    setEnroll(null)
    void queryClient.invalidateQueries({ queryKey: ["admin-access-session"] })
  }

  const accept = useMutation({
    mutationFn: (token: string) =>
      api<{ userId: string; role: "admin" | "support" }>("/api/admin/access/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => {
      toast.success("Invitación aceptada: ahora protege tu cuenta")
      refresh()
    },
  })

  const failure = session.error
  if (failure instanceof ApiError && failure.status === 401) {
    window.location.assign(panelUrl(`/login?next=${encodeURIComponent(window.location.href)}`))
    return <LoadingState message="Redirigiendo al inicio de sesión…" />
  }
  const notStaff =
    failure instanceof ApiError && failure.status === 403 && failure.shape.code === "STAFF_ONLY"

  let content: ReactNode
  if (session.isPending) {
    content = <LoadingState message="Verificando tu sesión…" />
  } else if (session.isError) {
    content =
      notStaff && invitation ? (
        <div className="flex flex-col gap-4">
          <Heading
            title="Te invitaron al equipo de odentIA"
            description="Inicia sesión con el correo invitado y verificado para aceptar."
          />
          <SubmitButton
            className="w-full"
            pending={accept.isPending}
            onClick={() => accept.mutate(invitation)}
          >
            Aceptar invitación
          </SubmitButton>
          {accept.isError ? <ErrorState message={apiMessage(accept.error)} /> : null}
        </div>
      ) : (
        <ErrorState
          message={
            failure instanceof ApiError ? (failure.shape.message ?? "Sin acceso") : "Sin conexión"
          }
          onRetry={() => void session.refetch()}
        />
      )
  } else if (savedCodes) {
    content = (
      <BackupCodesStep
        email={session.data.user.email}
        codes={savedCodes}
        onEnter={() => void enter()}
      />
    )
  } else if (session.data.verified) {
    content = (
      <VerifiedState
        method={session.data.method}
        onRevoked={refresh}
        onEnter={() => void enter()}
      />
    )
  } else if (!session.data.enrolled) {
    content = enroll ? (
      <ScanStep
        email={session.data.user.email}
        enroll={enroll}
        onBack={() => setEnroll(null)}
        onActivated={() => setSavedCodes(enroll.backupCodes)}
      />
    ) : (
      <PasswordStep
        email={session.data.user.email}
        hasPassword={session.data.hasPassword}
        onStarted={setEnroll}
        onAlreadyEnrolled={refresh}
      />
    )
  } else {
    content = (
      <ChallengeState
        name={session.data.user.name}
        email={session.data.user.email}
        onVerified={() => void enter()}
      />
    )
  }

  return <AccessLayout>{content}</AccessLayout>
}

function AccessLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-surface-muted px-4 py-6 md:justify-center md:py-10">
      <div className="mb-4 flex items-center gap-2.5 md:mb-5">
        <Brand className="w-32" />
        <Badge variant="secondary">Administración</Badge>
      </div>
      <main className="w-full max-w-[30rem] rounded-2xl border bg-card p-5 shadow-xs md:p-8">
        {children}
      </main>
    </div>
  )
}

function Heading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl leading-tight font-extrabold tracking-[-0.02em] text-balance">
        {title}
      </h1>
      {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
    </div>
  )
}

function StepLabel({ step, onBack }: { step: 1 | 2 | 3; onBack?: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-xs tracking-[0.08em] text-primary uppercase">
        Paso {step} de 3
      </span>
      {onBack ? (
        <Button type="button" variant="link" className="h-auto p-0" onClick={onBack}>
          Volver
        </Button>
      ) : null}
    </div>
  )
}

function StoreButtons() {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button
        className="min-h-11 flex-1 sm:min-h-9"
        render={<a href={AUTHENTICATOR_STORES.iphone} target="_blank" rel="noreferrer" />}
      >
        <Smartphone aria-hidden />
        Para iPhone
      </Button>
      <Button
        className="min-h-11 flex-1 sm:min-h-9"
        render={<a href={AUTHENTICATOR_STORES.android} target="_blank" rel="noreferrer" />}
      >
        <Smartphone aria-hidden />
        Para Android
      </Button>
    </div>
  )
}

function SignOutLink() {
  return (
    <p className="text-center text-sm text-muted-foreground">
      <Button type="button" variant="link" className="h-auto p-0" onClick={() => void signOut()}>
        Salir
      </Button>
    </p>
  )
}

/** Paso 1: para qué sirve, la app a instalar y la contraseña (tablero 1). */
function PasswordStep(props: {
  email: string
  hasPassword: boolean
  onStarted: (enroll: EnrollStart) => void
  onAlreadyEnrolled: () => void
}) {
  const [password, setPassword] = useState("")
  const start = useMutation({
    mutationFn: () =>
      api<EnrollStart>("/api/admin/access/mfa/enroll/start", {
        method: "POST",
        body: JSON.stringify({ password: password || undefined }),
      }),
    onSuccess: (data) => props.onStarted(data),
    onError: (error) => {
      if (apiCode(error) === "MFA_ENROLLED") props.onAlreadyEnrolled()
    },
  })
  const code = apiCode(start.error)
  const passwordError =
    code === "BAD_PASSWORD"
      ? "Esa no es tu contraseña. Es la misma con la que entras al panel."
      : code === "VALIDATION"
        ? "Escribe tu contraseña."
        : null

  return (
    <div className="flex flex-col gap-5">
      <StepLabel step={1} />
      <Heading
        title="Protege tu acceso a la administración"
        description="Desde aquí se ven todas las clínicas y sus cobros, así que el personal entra con su contraseña y un código de 6 dígitos que da una app de tu teléfono: si alguien consigue una, sin la otra no entra. Lo activas una sola vez y tarda un par de minutos."
      />
      <section
        aria-label="La app que necesitas"
        className="flex flex-col gap-2.5 rounded-xl border p-4"
      >
        <h2 className="text-sm font-bold">
          Antes de seguir, instala Google Authenticator en tu teléfono
        </h2>
        <p className="text-sm text-muted-foreground">
          Es gratis y es la app que te dará el código. Búscala en la tienda de tu teléfono o tócala
          aquí:
        </p>
        <StoreButtons />
        <p className="flex gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm text-accent-foreground">
          <Cloud aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <strong>Al abrirla, entra con tu cuenta de Google.</strong> Así tus códigos se guardan
            en la nube y, si pierdes el teléfono, vuelven solos al nuevo.
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          ¿Ya usas otra para tus códigos, como Authy o Microsoft Authenticator? También sirve: usa
          esa, con su copia en la nube activada.
        </p>
      </section>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          start.mutate()
        }}
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">Cuenta</span>
          <span className="text-sm text-muted-foreground">{props.email}</span>
        </div>
        {props.hasPassword ? (
          <Field>
            <FieldLabel htmlFor="enroll-password">Contraseña</FieldLabel>
            <PasswordInput
              id="enroll-password"
              value={password}
              onChange={(value) => {
                setPassword(value)
                if (start.isError) start.reset()
              }}
              autoComplete="current-password"
              autoFocus
              invalid={!!passwordError}
              describedBy={passwordError ? "enroll-password-error" : "enroll-password-help"}
            />
            {passwordError ? (
              <FieldError id="enroll-password-error">{passwordError}</FieldError>
            ) : (
              <FieldDescription id="enroll-password-help">
                La misma con la que entraste al panel.
              </FieldDescription>
            )}
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">
            Entraste con Google: no hace falta contraseña.
          </p>
        )}
        {start.isError && !passwordError && code !== "MFA_ENROLLED" ? (
          <p role="alert" className="text-sm text-destructive">
            {code === "FRESH_LOGIN_REQUIRED" ? (
              <>
                Vuelve a iniciar sesión para activarlo.{" "}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => void signOut()}
                >
                  Volver a entrar
                </Button>
              </>
            ) : (
              apiMessage(start.error)
            )}
          </p>
        ) : null}
        <SubmitButton type="submit" className="w-full" pending={start.isPending}>
          Continuar
        </SubmitButton>
      </form>
      <SignOutLink />
    </div>
  )
}

/** El campo de 6 dígitos: se puede pegar y al sexto se confirma solo (D5). */
function TotpCodeField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error: string | null
  help: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <Input
        id={props.id}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="000000"
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={`${props.id}-${props.error ? "error" : "help"}`}
        onChange={(event) => props.onChange(totpDigits(event.target.value))}
        className="h-12 font-mono text-2xl tracking-[0.4em]"
      />
      {props.error ? (
        <FieldError id={`${props.id}-error`}>{props.error}</FieldError>
      ) : (
        <FieldDescription id={`${props.id}-help`}>{props.help}</FieldDescription>
      )}
    </Field>
  )
}

function CopyButton({
  text,
  label = "Copiar",
  className,
}: {
  text: string
  label?: string
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => toast.success("Copiado"))
          .catch(() => toast.error("No se pudo copiar: selecciónalo y cópialo a mano"))
      }}
    >
      {label}
    </Button>
  )
}

/** Paso 2: el QR (o, en el teléfono, abrir la app), la clave y el código (tableros 2, 6 y 7). */
function ScanStep(props: {
  email: string
  enroll: EnrollStart
  onBack: () => void
  onActivated: () => void
}) {
  const touch = useTouchDevice()
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [storesOpen, setStoresOpen] = useState(false)
  const secret = groupedSecret(totpSecret(props.enroll.totpURI))

  useEffect(() => {
    let alive = true
    void totpQrDataUrl(props.enroll.totpURI).then((url) => {
      if (alive) setQr(url)
    })
    return () => {
      alive = false
    }
  }, [props.enroll.totpURI])

  const confirm = useMutation({
    mutationFn: (value: string) =>
      api<{ verified: boolean }>("/api/admin/access/mfa/enroll/confirm", {
        method: "POST",
        body: JSON.stringify({ code: value }),
      }),
    onSuccess: () => props.onActivated(),
  })
  const changeCode = (value: string) => {
    setCode(value)
    if (confirm.isError) confirm.reset()
    if (value.length === 6 && !confirm.isPending) confirm.mutate(value)
  }

  const qrImage = (
    <div className="size-44 shrink-0 rounded-xl border bg-white p-1.5">
      {qr ? (
        <img src={qr} alt="Código QR para agregar odentIA a tu app" className="size-full" />
      ) : (
        <div className="size-full animate-pulse rounded-lg bg-muted" />
      )}
    </div>
  )
  const manualKey = (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        En la app elige «Ingresar una clave de configuración», tipo «Basada en el tiempo».
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-[15px] tracking-[0.06em]">
          {secret}
        </code>
        <CopyButton text={secret.replace(/\s/g, "")} className="min-h-11 sm:min-h-9" />
      </div>
    </div>
  )
  const stores = (
    <Collapsible open={storesOpen} onOpenChange={setStoresOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger
        render={<Button type="button" variant="link" className="h-auto self-start p-0" />}
      >
        ¿Aún no tienes la app? Descárgala
      </CollapsibleTrigger>
      <CollapsibleContent>
        <StoreButtons />
      </CollapsibleContent>
    </Collapsible>
  )

  return (
    <div className="flex flex-col gap-5">
      <StepLabel step={2} onBack={props.onBack} />
      {touch ? (
        <>
          <Heading
            title="Agrega odentIA a tu app"
            description="Estás en el teléfono: no puedes escanear tu propia pantalla. Ábrelo directo en la app de autenticación. Se abrirá Google Authenticator (o la app que ya usas) y te preguntará si quieres agregar «odentIA»: toca «Agregar»."
          />
          <Button className="min-h-11 w-full" render={<a href={props.enroll.totpURI} />}>
            Abrir en mi app de autenticación
          </Button>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">
              ¿No se abrió? Copia la clave y pégala en la app.
            </span>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-muted px-3 py-2.5 font-mono text-sm tracking-[0.05em]">
                {secret}
              </code>
              <CopyButton text={secret.replace(/\s/g, "")} className="min-h-11" />
            </div>
          </div>
          {stores}
          <Collapsible className="flex flex-col gap-3 border-t pt-3">
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="link"
                  className="group h-auto min-h-11 self-start p-0"
                />
              }
            >
              La app está en otro teléfono: ver el código QR
              <ChevronDown
                aria-hidden
                className="transition-transform group-data-[panel-open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex justify-center">{qrImage}</CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <>
          <Heading
            title="Escanea el código con tu app"
            description="Toma tu teléfono y sigue estos pasos."
          />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {qrImage}
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-foreground">
                <li>
                  Abre <strong>Google Authenticator</strong> (o la app que ya usas).
                </li>
                <li>
                  Toca <strong>«+»</strong> y luego <strong>«Escanear un código QR»</strong>.
                </li>
                <li>Apunta la cámara a este código.</li>
              </ol>
              <span>Aparecerá «odentIA» con un número de 6 dígitos.</span>
              {stores}
            </div>
          </div>
          <Collapsible className="flex flex-col gap-2 rounded-xl border px-4 py-3">
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="group h-auto justify-between px-0 text-foreground hover:bg-transparent aria-expanded:bg-transparent"
                />
              }
            >
              ¿No puedes escanear? Escribe esta clave
              <ChevronDown
                aria-hidden
                className="transition-transform group-data-[panel-open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>{manualKey}</CollapsibleContent>
          </Collapsible>
        </>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.length === 6) confirm.mutate(code)
        }}
      >
        <TotpCodeField
          id="enroll-code"
          label={
            touch
              ? "Vuelve aquí y escribe el código de 6 dígitos"
              : "Escribe el código de 6 dígitos que muestra la app"
          }
          value={code}
          onChange={changeCode}
          error={confirm.isError ? codeError(confirm.error) : null}
          help="Cambia cada 30 segundos. Al escribir el sexto número se confirma solo."
        />
        <SubmitButton
          type="submit"
          className="w-full"
          pending={confirm.isPending}
          disabled={code.length < 6}
        >
          Activar
        </SubmitButton>
      </form>
    </div>
  )
}

/** Paso 3: los códigos de respaldo, recién activado; no se entra sin «Los guardé» (tablero 3). */
function BackupCodesStep(props: { email: string; codes: string[]; onEnter: () => void }) {
  const [saved, setSaved] = useState(false)
  const download = () => {
    const blob = new Blob([backupCodesText(props.email, props.codes)], {
      type: "text/plain;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "odentia-codigos-de-respaldo.txt"
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex flex-col gap-5">
      <StepLabel step={3} />
      <p
        role="status"
        className="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm font-bold text-success"
      >
        <Check aria-hidden className="size-4" />
        Segundo factor activado
      </p>
      <Heading
        title="Guarda tus códigos de respaldo"
        description="Son tu llave de emergencia. Si pierdes el teléfono o cambias de equipo y ya no tienes tu app, entras con uno de estos en vez del código de 6 dígitos."
      />
      <ul className="flex flex-col gap-1.5 text-sm">
        <li>
          <strong>Cada código sirve una sola vez.</strong> Tienes {props.codes.length}.
        </li>
        <li>
          <strong>Guárdalos fuera de este navegador:</strong> en tu gestor de contraseñas o
          impresos.
        </li>
        <li>
          <strong>Esta es la única vez que los ves.</strong> Al usar uno, te pediremos activar tu
          teléfono nuevo y te daremos códigos nuevos.
        </li>
      </ul>
      <ul aria-label="Códigos de respaldo" className="grid grid-cols-2 gap-2 rounded-xl border p-3">
        {props.codes.map((backup) => (
          <li
            key={backup}
            className="rounded-md bg-muted px-2 py-1.5 text-center font-mono text-[15px] tracking-[0.04em]"
          >
            {backup}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row">
        <CopyButton text={props.codes.join("\n")} className="min-h-11 flex-1 sm:min-h-9" />
        <Button
          type="button"
          variant="outline"
          className="min-h-11 flex-1 sm:min-h-9"
          onClick={download}
        >
          Descargar (.txt)
        </Button>
      </div>
      <Collapsible className="flex flex-col gap-2 rounded-xl border px-4 py-3">
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="group h-auto justify-between px-0 text-foreground hover:bg-transparent aria-expanded:bg-transparent"
            />
          }
        >
          Si pierdes el teléfono, tienes tres salidas
          <ChevronDown
            aria-hidden
            className="transition-transform group-data-[panel-open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-sm">
            <li>
              <strong>Tu cuenta de Google:</strong> en el teléfono nuevo instala la app, entra con
              tu cuenta y tus códigos vuelven.
            </li>
            <li>
              <strong>Estos códigos de respaldo:</strong> entras con uno y activas el teléfono
              nuevo.
            </li>
            <li>
              <strong>Otro administrador:</strong> puede reiniciar tu segundo factor desde «Equipo».
            </li>
          </ol>
        </CollapsibleContent>
      </Collapsible>
      <label htmlFor="codes-saved" className="flex items-center gap-2.5 text-sm font-semibold">
        <Checkbox
          id="codes-saved"
          checked={saved}
          onCheckedChange={(checked) => setSaved(checked === true)}
        />
        Los guardé en un lugar seguro
      </label>
      <Button type="button" size="lg" className="w-full" disabled={!saved} onClick={props.onEnter}>
        Entrar a la administración
      </Button>
      {!saved ? (
        <p className="text-center text-xs text-muted-foreground">
          El botón se habilita al marcar «Los guardé».
        </p>
      ) : null}
    </div>
  )
}

/** Las veces siguientes: solo el código; el respaldo es un enlace, no una casilla (tableros 4 y 5). */
function ChallengeState(props: { name: string; email: string; onVerified: () => void }) {
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState("")
  const verify = useMutation({
    mutationFn: (value: string) =>
      api<{ verified: boolean }>("/api/admin/access/challenge/verify", {
        method: "POST",
        body: JSON.stringify({ code: value, method: recovery ? "recovery" : "totp" }),
      }),
    onSuccess: () => {
      if (recovery) toast.success("Entraste con un código de respaldo: activa tu teléfono nuevo")
      props.onVerified()
    },
  })
  const firstName = props.name.trim().split(/\s+/)[0]
  const switchMode = () => {
    setRecovery((value) => !value)
    setCode("")
    verify.reset()
  }

  return (
    <div className="flex flex-col gap-5">
      <Heading
        title={recovery ? "Escribe un código de respaldo" : "Escribe el código de tu app"}
        description={
          recovery
            ? "Uno de los 10 que guardaste al activar el segundo factor. Cada código sirve una sola vez."
            : `${firstName ? `Hola, ${firstName}. ` : ""}Tu contraseña ya está; abre tu app de autenticación y busca «odentIA · ${props.email}».`
        }
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim()) verify.mutate(code.trim())
        }}
      >
        {recovery ? (
          <>
            <Field>
              <FieldLabel htmlFor="backup-code">Código de respaldo</FieldLabel>
              <Input
                id="backup-code"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="xxxx-xxxx"
                value={code}
                aria-invalid={verify.isError || undefined}
                aria-describedby={verify.isError ? "backup-code-error" : undefined}
                onChange={(event) => {
                  setCode(event.target.value)
                  if (verify.isError) verify.reset()
                }}
                className="h-12 font-mono text-xl tracking-[0.12em]"
              />
              <FieldError id="backup-code-error">
                {verify.isError ? codeError(verify.error, true) : null}
              </FieldError>
            </Field>
            <div className="flex flex-col gap-1 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">
              <strong>Después de entrar, cambia de teléfono.</strong>
              <span>
                Entrar con un código de respaldo dura poco: te llevaremos a activar el segundo
                factor en tu teléfono nuevo.
              </span>
            </div>
          </>
        ) : (
          <TotpCodeField
            id="challenge-code"
            label="Código de 6 dígitos"
            value={code}
            onChange={(value) => {
              setCode(value)
              if (verify.isError) verify.reset()
              if (value.length === 6 && !verify.isPending) verify.mutate(value)
            }}
            error={verify.isError ? codeError(verify.error) : null}
            help="Al escribir el sexto número entras solo."
          />
        )}
        <SubmitButton
          type="submit"
          className="w-full"
          pending={verify.isPending}
          disabled={recovery ? !code.trim() : code.length < 6}
        >
          Entrar
        </SubmitButton>
      </form>
      <Button type="button" variant="link" className="h-auto self-start p-0" onClick={switchMode}>
        {recovery ? "Usar el código de la app" : "Usar un código de respaldo"}
      </Button>
      <p className="border-t pt-4 text-sm text-muted-foreground">
        ¿Perdiste el teléfono y los códigos? Pide a otro administrador que reinicie tu segundo
        factor desde «Equipo».
      </p>
      <SignOutLink />
    </div>
  )
}

/** Ya protegido: entrar, o revocar el factor para cambiar de teléfono (sin cambios de fondo). */
function VerifiedState(props: {
  method: "totp" | "recovery" | null
  onRevoked: () => void
  onEnter: () => void
}) {
  const [password, setPassword] = useState("")
  const revoke = useMutation({
    mutationFn: () =>
      api<{ ok: true }>("/api/admin/access/mfa/revoke", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      toast.success("Factor revocado: activa tu teléfono nuevo")
      setPassword("")
      props.onRevoked()
    },
  })
  const passwordError = apiCode(revoke.error) === "BAD_PASSWORD" ? "Esa no es tu contraseña." : null
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge>Protegido</Badge>
      </div>
      <Heading
        title="Tu acceso está protegido"
        description={
          props.method === "recovery"
            ? "Entraste con un código de respaldo, que dura poco."
            : "Tu sesión tiene el segundo factor activado."
        }
      />
      {props.method === "recovery" ? (
        <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">
          Activa tu teléfono nuevo ahora: revoca el factor con tu contraseña y actívalo otra vez.
        </p>
      ) : null}
      <Button type="button" size="lg" className="w-full" onClick={props.onEnter}>
        Entrar a la administración
      </Button>
      <form
        className="flex flex-col gap-3 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault()
          revoke.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="revoke-password">
            ¿Cambiaste de teléfono? Revoca tu factor con tu contraseña
          </FieldLabel>
          <PasswordInput
            id="revoke-password"
            value={password}
            onChange={(value) => {
              setPassword(value)
              if (revoke.isError) revoke.reset()
            }}
            autoComplete="current-password"
            invalid={!!passwordError}
            describedBy={revoke.isError ? "revoke-password-error" : undefined}
          />
          <FieldError id="revoke-password-error">
            {revoke.isError ? (passwordError ?? apiMessage(revoke.error)) : null}
          </FieldError>
        </Field>
        <SubmitButton
          type="submit"
          variant="destructive"
          pending={revoke.isPending}
          disabled={password.length === 0}
        >
          Revocar mi factor
        </SubmitButton>
      </form>
    </div>
  )
}
