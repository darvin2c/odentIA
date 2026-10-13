// Correo (Gmail / Microsoft 365): página propia separada de Canales.
// Conectar por OAuth del proveedor (nunca se pegan tokens), probar y
// desconectar. Lectura de metadatos con conversations.read; gestión con
// settings.write. El padre la registra en /settings/mail.
import { Badge, Button } from "@odentia/ui"
import { EmptyState, PageHeader } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Mail } from "lucide-react"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

/** Resultado de la autorización: el proveedor vuelve a esta página con él en la dirección. */
interface MailSearch {
  /** Llega como `ok=1`; se conserva tal cual para que el router no reescriba la dirección. */
  ok?: string | number
  buzon?: string
  error?: string
}

const searchText = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

export const Route = createFileRoute("/_org/settings/mail")({
  // Se lee del router y no de `window`: así la página también se genera en el servidor.
  validateSearch: (search: Record<string, unknown>): MailSearch => {
    const ok = typeof search.ok === "number" ? search.ok : searchText(search.ok)
    const buzon = searchText(search.buzon)
    const error = searchText(search.error)
    return { ...(ok !== undefined ? { ok } : {}), ...(buzon ? { buzon } : {}), ...(error ? { error } : {}) }
  },
  component: MailPage,
})

type MailboxProvider = "gmail" | "microsoft365"

interface MailProvider {
  provider: MailboxProvider
  label: string
  channel: string
  configured: boolean
}

interface MailConnection {
  id: string
  provider: MailboxProvider
  email: string | null
  displayName: string
  status: string
  synced: boolean
  createdAt: string
  updatedAt: string
}

interface MailState {
  providers: MailProvider[]
  connections: MailConnection[]
}

const ENV_HINT: Record<MailboxProvider, string> = {
  gmail: "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET y GMAIL_REDIRECT_URI",
  microsoft365:
    "MICROSOFT_MAIL_CLIENT_ID, MICROSOFT_MAIL_CLIENT_SECRET y MICROSOFT_MAIL_REDIRECT_URI",
}

const PROVIDER_HELP: Record<MailboxProvider, string> = {
  gmail:
    "Lee con history incremental y responde en el mismo hilo. Permisos mínimos: gmail.readonly y gmail.send.",
  microsoft365:
    "Lee con delta del Inbox y responde en el mismo hilo. Permisos mínimos: Mail.Read, Mail.Send y User.Read. Microsoft no permite revocar por API: desconectar borra los tokens locales.",
}

function bannerFromSearch(search: MailSearch): { ok: string | null; error: string | null } {
  return { ok: search.ok ? (search.buzon ?? "buzón") : null, error: search.error ?? null }
}

function errorText(code: string | null): string {
  switch (code) {
    case "oauth-denegado":
      return "Cancelaste la autorización en el proveedor: no se conectó nada."
    case "oauth-sin-sesion":
      return "Tu sesión caducó durante la autorización: entra de nuevo y reintenta."
    default:
      return "La conexión falló (código caducado, proveedor no configurado o permiso denegado). Reintenta."
  }
}

function MailPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("conversations.read")
  const canManage = usePermission("settings.write")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const search = Route.useSearch()
  // El aviso es el de la llegada: no cambia aunque después cambie la dirección.
  const [banner] = useState(() => bannerFromSearch(search))

  const mailQuery = useQuery({
    queryKey: ["mail"],
    queryFn: () => apiFetch<{ data: MailState }>("/api/mail/connections"),
    enabled: canRead,
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["mail"] })
  }

  function fail(e: unknown, fallback: string): void {
    setError(e instanceof ApiError ? (e.shape.message ?? fallback) : fallback)
  }

  async function connect(provider: MailboxProvider): Promise<void> {
    setError(null)
    setBusy(`connect:${provider}`)
    try {
      const res = await apiFetch<{ data: { url: string } }>("/api/mail/oauth/start", {
        method: "POST",
        body: JSON.stringify({ provider }),
      })
      window.location.href = res.data.url
    } catch (e) {
      fail(e, "No se pudo iniciar la conexión")
      setBusy(null)
    }
  }

  async function test(id: string): Promise<void> {
    setError(null)
    setBusy(`test:${id}`)
    try {
      await apiFetch(`/api/mail/${id}/test`, { method: "POST" })
      invalidate()
    } catch (e) {
      fail(e, "La prueba falló: el buzón puede necesitar reconexión")
    } finally {
      setBusy(null)
    }
  }

  async function disconnect(id: string): Promise<void> {
    setError(null)
    setBusy(`disconnect:${id}`)
    try {
      await apiFetch(`/api/mail/${id}/disconnect`, { method: "POST" })
      invalidate()
    } catch (e) {
      fail(e, "No se pudo desconectar")
    } finally {
      setBusy(null)
    }
  }

  if (!canRead) {
    return (
      <EmptyState
        title="Sin acceso"
        description="Necesitas permiso de lectura de conversaciones para ver los buzones."
      />
    )
  }

  const state = mailQuery.data?.data
  const providers = state?.providers ?? []
  const connections = state?.connections ?? []

  const connectionOf = (provider: MailboxProvider): MailConnection | undefined =>
    connections.find((conn) => conn.provider === provider)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Correo"
        subtitle="Buzones Gmail y Microsoft 365 para conversar por email"
      />
      {banner.ok && (
        <p className="rounded-lg border border-success/30 bg-success-soft p-4 text-sm">
          Buzón {banner.ok} conectado: ya puedes conversar desde la bandeja.
        </p>
      )}
      {banner.error && (
        <p className="rounded-lg border border-destructive/30 bg-danger-soft p-4 text-sm">
          {errorText(banner.error)}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {mailQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando buzones…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {providers.map((provider) => {
            const conn = connectionOf(provider.provider)
            const isBusy = busy !== null
            return (
              <section
                key={provider.provider}
                className="flex flex-col gap-3 rounded-lg border p-4"
                aria-label={provider.label}
              >
                <div className="flex items-center gap-2">
                  <Mail className="size-4 shrink-0 text-primary" aria-hidden />
                  <h2 className="font-medium">{provider.label}</h2>
                  {conn ? (
                    <Badge variant={conn.status === "active" ? "default" : "secondary"}>
                      {conn.status === "active" ? "Conectado" : "Desactivado"}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Sin conectar</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{PROVIDER_HELP[provider.provider]}</p>
                {conn && (
                  <div className="flex flex-col gap-1 text-sm">
                    <span className="break-all font-medium">{conn.email ?? conn.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {conn.synced
                        ? "Sincronizando correo nuevo"
                        : "Primer sondeo pendiente: fijará el punto de partida sin importar historial"}
                      {conn.status !== "active" ? " · reconecta para reactivar" : ""}
                    </span>
                  </div>
                )}
                {!provider.configured && !conn && (
                  <p className="text-sm text-warning">
                    Proveedor no configurado en este entorno (falta{" "}
                    {ENV_HINT[provider.provider]}): la conexión queda deshabilitada, sin
                    simular nada.
                  </p>
                )}
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {!conn && provider.configured && (
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={isBusy}
                        onClick={() => void connect(provider.provider)}
                      >
                        Conectar con {provider.label}
                      </Button>
                    )}
                    {!conn && !provider.configured && (
                      <Button type="button" className="min-h-11" disabled>
                        Conectar con {provider.label}
                      </Button>
                    )}
                    {conn && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={isBusy}
                          onClick={() => void test(conn.id)}
                        >
                          {busy === `test:${conn.id}` ? "Probando…" : "Probar"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={isBusy}
                          onClick={() => void disconnect(conn.id)}
                        >
                          {busy === `disconnect:${conn.id}` ? "Desconectando…" : "Desconectar"}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
      {!mailQuery.isLoading && providers.length === 0 && (
        <EmptyState
          title="Sin proveedores"
          description="El API aún no expone proveedores de correo."
        />
      )}
    </div>
  )
}
