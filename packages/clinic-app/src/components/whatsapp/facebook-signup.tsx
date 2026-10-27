import { Alert, AlertDescription, AlertTitle, Button } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, apiFetch } from "../../lib/api"
import { orgSlugFromHostname, panelUrl, requestHostname } from "../../lib/host"

/**
 * «Conectar con Facebook» de WhatsApp (Embedded Signup de Meta), del lado de
 * la clínica.
 *
 * La ventana de Meta no se abre aquí: Meta solo devuelve el resultado a una
 * página cuyo dominio está en «Dominios permitidos para el SDK para
 * JavaScript», y esa lista no admite comodín para los subdominios de cada
 * clínica (issue 166). El botón lleva al panel (`app.<dominio>/whatsapp/conectar`),
 * que abre la ventana, guarda la conexión con la misma operación
 * (`POST /api/channels/whatsapp/signup`) y vuelve a la página de WhatsApp con
 * `?conectado=<id>`. Aquí quedan el botón y lo que quedó pendiente.
 */

interface SignupConfig {
  enabled: boolean
}

/** Un paso que el servidor no pudo completar en Meta después de guardar la conexión. */
export interface FacebookSignupPendingStep {
  step: string
  /** Qué falta y qué no funciona mientras tanto. */
  title: string
  /** Qué respondió Meta la última vez y qué hacer; `null` si aún no se intentó. */
  problem: string | null
}

/** La conexión tal como la devuelve el servidor al conectar, volver a conectar o reintentar. */
export interface FacebookSignupConnection {
  id: string
  channel: string
  provider: string
  displayName: string
  externalId: string | null
  status: string
  /** La cuenta que Meta reconoció. */
  account: { name: string | null; number: string | null } | null
  /** Cómo quedó la solicitud de los mensajes de la clínica. */
  templates: { canManage: boolean; requested: number; error: string | null } | null
  health: {
    quality: "alta" | "media" | "baja" | null
    dailyLimit: number | null
    unlimited: boolean
    number: string | null
    name: string | null
    checkedAt: string
  } | null
  /** Con algo en `pending`, la conexión necesita atención. */
  signup: {
    grantedAt: string
    subscribedAt: string | null
    registeredAt: string | null
    pending: FacebookSignupPendingStep[]
  } | null
  createdAt: string
  updatedAt: string
}

export interface FacebookSignupButtonProps {
  /** Volver a conectar esta conexión (hecha con el botón) en vez de crear otra. */
  reconnectConnectionId?: string
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

/**
 * Lo que quedó pendiente de una conexión hecha con el botón, con «Reintentar».
 * Sirve tanto recién conectada como al abrirla después desde la lista.
 */
export function FacebookSignupPending({
  connection,
  onResolved,
}: {
  connection: Pick<FacebookSignupConnection, "id" | "signup">
  /** El reintento respondió: la conexión con lo que siga pendiente, si algo. */
  onResolved: (connection: FacebookSignupConnection) => void
}) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () =>
      apiFetch<{ data: FacebookSignupConnection }>(`/api/channels/whatsapp/signup/${connection.id}/retry`, { method: "POST" }),
    onSuccess: async ({ data }) => {
      await queryClient.invalidateQueries({ queryKey: ["connections"] })
      onResolved(data)
    },
  })
  const pending = connection.signup?.pending ?? []
  if (pending.length === 0) return null
  return (
    <Alert>
      <AlertTitle>{pending.length === 1 ? "Falta un paso para terminar de conectar" : "Faltan pasos para terminar de conectar"}</AlertTitle>
      <AlertDescription>
        <ul className="flex list-none flex-col gap-2 p-0">
          {pending.map((item) => (
            <li key={item.step} className="flex flex-col gap-0.5">
              <span className="text-foreground">{item.title}</span>
              {item.problem ? <span>{item.problem}</span> : null}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SubmitButton variant="outline" size="sm" pending={retry.isPending} onClick={() => retry.mutate()}>
            Reintentar
          </SubmitButton>
          {retry.isError ? (
            <span role="alert" className="text-sm text-destructive">
              {errorText(retry.error, "No pudimos reintentar. Vuelve a intentarlo en un momento.")}
            </span>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * Si esta instalación tiene «Conectar con Facebook» (la app de odentIA en Meta)
 * y la página es de una clínica. `loading`: aún no se sabe.
 */
export function useFacebookSignupAvailable(): { available: boolean; loading: boolean } {
  const config = useQuery({
    queryKey: ["whatsapp-signup"],
    queryFn: () => apiFetch<{ data: SignupConfig }>("/api/channels/whatsapp/signup"),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const slug = orgSlugFromHostname(requestHostname())
  return { available: Boolean(config.data?.data.enabled && slug), loading: config.isPending }
}

/**
 * Botón «Conectar con Facebook». No se dibuja si la instalación no tiene la app
 * de odentIA configurada (`GET /api/channels/whatsapp/signup` → `enabled`).
 * Lleva, en la misma pestaña, a la página del panel que abre la ventana de
 * Meta; al terminar, el panel vuelve aquí.
 */
export function FacebookSignupButton({ reconnectConnectionId }: FacebookSignupButtonProps) {
  const { available } = useFacebookSignupAvailable()
  const slug = orgSlugFromHostname(requestHostname())
  if (!available || !slug) return null
  const search = new URLSearchParams({ org: slug, ...(reconnectConnectionId ? { reconectar: reconnectConnectionId } : {}) })
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button className="min-h-11 sm:min-h-9" render={<a href={panelUrl(`/whatsapp/conectar?${search.toString()}`)} />}>
        {reconnectConnectionId ? "Volver a conectar con Facebook" : "Conectar con Facebook"}
      </Button>
    </div>
  )
}
