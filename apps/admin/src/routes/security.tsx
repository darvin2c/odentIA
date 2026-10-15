import { Badge, Button, Field, FieldError, FieldLabel, Input, toast } from "@odentia/ui"
import { ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api } from "../lib/api"
import { panelUrl } from "../lib/host"
export const Route = createFileRoute("/security")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.invitation === "string" ? { invitation: search.invitation } : {}),
  }),
  component: SecurityPage,
})

interface AccessSession {
  actor: { userId: string; role: "admin" | "support" }
  user: { name: string; email: string; image: string | null }
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
  return "No pudimos conectar con el servidor"
}

/** Extrae el secreto para ingreso manual (sin dependencia de QR). */
function totpSecret(uri: string): string {
  const match = /[?&]secret=([^&]+)/i.exec(uri)
  return match?.[1] ? decodeURIComponent(match[1]) : ""
}

function SecurityPage() {
  const { invitation } = Route.useSearch()
  const queryClient = useQueryClient()
  const session = useQuery({
    queryKey: ["admin-access-session"],
    queryFn: () => api<AccessSession>("/api/admin/access/session"),
    retry: false,
  })
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [recovery, setRecovery] = useState(false)
  const [enroll, setEnroll] = useState<EnrollStart | null>(null)
  const [revokePassword, setRevokePassword] = useState("")

  const refresh = () => {
    setEnroll(null)
    setCode("")
    setPassword("")
    void queryClient.invalidateQueries({ queryKey: ["admin-access-session"] })
  }

  const enrollStart = useMutation({
    mutationFn: () =>
      api<EnrollStart>("/api/admin/access/mfa/enroll/start", {
        method: "POST",
        body: JSON.stringify({ password: password || undefined }),
      }),
    onSuccess: (data) => {
      setEnroll(data)
      toast.success("Escanea el código o ingresa la clave en tu app")
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

  const enrollConfirm = useMutation({
    mutationFn: () =>
      api<{ verified: boolean }>("/api/admin/access/mfa/enroll/confirm", {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    onSuccess: () => {
      toast.success("Segundo factor activado")
      refresh()
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

  const challenge = useMutation({
    mutationFn: () =>
      api<{ verified: boolean }>("/api/admin/access/challenge/verify", {
        method: "POST",
        body: JSON.stringify({ code, method: recovery ? "recovery" : "totp" }),
      }),
    onSuccess: (data, variables) => {
      void data
      void variables
      toast.success(
        recovery ? "Recuperación verificada: renueva tu factor" : "Identidad verificada",
      )
      refresh()
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

  const revoke = useMutation({
    mutationFn: () =>
      api<{ ok: true }>("/api/admin/access/mfa/revoke", {
        method: "POST",
        body: JSON.stringify({ password: revokePassword }),
      }),
    onSuccess: () => {
      toast.success("Factor revocado: vuelve a enrolar uno nuevo")
      setRevokePassword("")
      refresh()
    },
    onError: (error) => toast.error(apiMessage(error)),
  })

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
    onError: (error) => toast.error(apiMessage(error)),
  })

  const failure = session.error
  if (failure instanceof ApiError && failure.status === 401) {
    window.location.assign(panelUrl(`/login?next=${encodeURIComponent(window.location.href)}`))
    return <LoadingState message="Redirigiendo al inicio de sesión…" />
  }
  const notStaff =
    failure instanceof ApiError && failure.status === 403 && failure.shape.code === "STAFF_ONLY"

  return (
    <PageShell maxWidth="md">
      <PageHeader title="Seguridad" subtitle="Segundo factor obligatorio del personal" />
      {session.isPending ? (
        <LoadingState message="Verificando tu sesión…" />
      ) : session.isError ? (
        notStaff && invitation ? (
          <section aria-label="Aceptar invitación" className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Fuiste invitado al personal. Inicia sesión con el correo invitado y verificado para
              aceptar.
            </p>
            <Button onClick={() => accept.mutate(invitation)} disabled={accept.isPending}>
              {accept.isPending ? "Aceptando…" : "Aceptar invitación"}
            </Button>
            {accept.isError ? <ErrorState message={apiMessage(accept.error)} /> : null}
          </section>
        ) : (
          <ErrorState
            message={
              failure instanceof ApiError ? (failure.shape.message ?? "Sin acceso") : "Sin conexión"
            }
            onRetry={() => void session.refetch()}
          />
        )
      ) : session.data.verified ? (
        <VerifiedState
          method={session.data.method}
          revokePassword={revokePassword}
          onRevokePassword={setRevokePassword}
          onRevoke={() => revoke.mutate()}
          revoking={revoke.isPending}
        />
      ) : !session.data.enrolled ? (
        <EnrollState
          email={session.data.user.email}
          password={password}
          onPassword={setPassword}
          starting={enrollStart.isPending}
          onStart={() => enrollStart.mutate()}
          enroll={enroll}
          code={code}
          onCode={setCode}
          confirming={enrollConfirm.isPending}
          onConfirm={() => enrollConfirm.mutate()}
        />
      ) : (
        <ChallengeState
          code={code}
          onCode={setCode}
          recovery={recovery}
          onRecovery={setRecovery}
          verifying={challenge.isPending}
          onVerify={() => challenge.mutate()}
        />
      )}
      {session.data?.verified && (
        <Button className="mt-4" render={<Link to="/" />}>
          Entrar a administración
        </Button>
      )}
    </PageShell>
  )
}

function VerifiedState(props: {
  method: "totp" | "recovery" | null
  revokePassword: string
  onRevokePassword: (value: string) => void
  onRevoke: () => void
  revoking: boolean
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Badge>Protegido</Badge>
        <span className="text-sm text-muted-foreground">
          {props.method === "recovery"
            ? "Entraste con código de respaldo (vigencia corta)."
            : "Tu sesión tiene segundo factor vinculado."}
        </span>
      </div>
      {props.method === "recovery" ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Renueva tu factor ahora: revócalo con tu contraseña y enrola uno nuevo.
        </p>
      ) : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          props.onRevoke()
        }}
      >
        <Field>
          <FieldLabel htmlFor="revoke-password">Revocar mi factor (exige contraseña)</FieldLabel>
          <Input
            id="revoke-password"
            type="password"
            autoComplete="current-password"
            value={props.revokePassword}
            onChange={(event) => props.onRevokePassword(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="destructive"
          disabled={props.revoking || props.revokePassword.length === 0}
        >
          {props.revoking ? "Revocando…" : "Revocar mi factor"}
        </Button>
      </form>
    </div>
  )
}

function EnrollState(props: {
  email: string
  password: string
  onPassword: (value: string) => void
  starting: boolean
  onStart: () => void
  enroll: EnrollStart | null
  code: string
  onCode: (value: string) => void
  confirming: boolean
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Tu cuenta ({props.email}) aún no tiene segundo factor. Enrólalo con tu app de autenticación.
      </p>
      {!props.enroll ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            props.onStart()
          }}
        >
          <Field>
            <FieldLabel htmlFor="enroll-password">
              Contraseña (si tu cuenta usa correo y contraseña)
            </FieldLabel>
            <Input
              id="enroll-password"
              type="password"
              autoComplete="current-password"
              value={props.password}
              onChange={(event) => props.onPassword(event.target.value)}
            />
            <FieldError>{null}</FieldError>
          </Field>
          <Button type="submit" disabled={props.starting}>
            {props.starting ? "Generando…" : "Generar código de enrolamiento"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium">1. Agrega esta clave en tu app</p>
            <code className="mt-1 block break-all rounded-md bg-muted px-3 py-2 text-xs">
              {props.enroll.totpURI}
            </code>
            {totpSecret(props.enroll.totpURI) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Clave manual: {totpSecret(props.enroll.totpURI)}
              </p>
            ) : null}
          </div>
          <div>
            <p className="text-sm font-medium">2. Guarda tus códigos de respaldo (un solo uso)</p>
            <ul className="mt-1 grid grid-cols-2 gap-1">
              {props.enroll.backupCodes.map((backup) => (
                <li key={backup}>
                  <code className="block rounded-md bg-muted px-2 py-1 text-xs">{backup}</code>
                </li>
              ))}
            </ul>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              props.onConfirm()
            }}
          >
            <Field>
              <FieldLabel htmlFor="enroll-code">3. Ingresa el código de tu app</FieldLabel>
              <Input
                id="enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={props.code}
                onChange={(event) => props.onCode(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={props.confirming || props.code.trim().length < 4}>
              {props.confirming ? "Verificando…" : "Activar segundo factor"}
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}

function ChallengeState(props: {
  code: string
  onCode: (value: string) => void
  recovery: boolean
  onRecovery: (value: boolean) => void
  verifying: boolean
  onVerify: () => void
}) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        props.onVerify()
      }}
    >
      <p className="text-sm text-muted-foreground">
        Tu sesión aún no tiene segundo factor vinculado.
      </p>
      <Field>
        <FieldLabel htmlFor="challenge-code">
          {props.recovery ? "Código de respaldo" : "Código de tu app"}
        </FieldLabel>
        <Input
          id="challenge-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={props.code}
          onChange={(event) => props.onCode(event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={props.recovery}
          onChange={(event) => props.onRecovery(event.target.checked)}
        />
        Usar código de respaldo (un solo uso, vigencia corta)
      </label>
      <Button type="submit" disabled={props.verifying || props.code.trim().length < 4}>
        {props.verifying ? "Verificando…" : "Verificar"}
      </Button>
    </form>
  )
}
