import { Button } from "@odentia/ui"
import { FormDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react"
import type { FormEvent, ReactNode } from "react"
import { type AgentModelStatus, type AgentOverview, MODEL_CHECK_TEXT } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { AGENT_MODEL_LABEL } from "../../lib/crm"

function Check({
  ok,
  checking = false,
  title,
  detail,
  action,
}: {
  ok: boolean
  /** Todavía se está comprobando: ni listo ni falta. */
  checking?: boolean
  title: string
  detail: string
  action?: ReactNode
}) {
  return (
    <li className="flex flex-wrap items-start gap-2.5 rounded-xl border p-3" aria-busy={checking || undefined}>
      <span className={`mt-0.5 shrink-0 [&>svg]:size-5 ${checking ? "text-muted-foreground" : ok ? "text-success" : "text-warning"}`}>
        {checking ? (
          <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
        ) : ok ? (
          <CircleCheck aria-hidden />
        ) : (
          <CircleAlert aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">{title}</span>
        <span className="sr-only">{checking ? " (comprobando)" : ok ? " (listo)" : " (falta)"}</span>
        <span className="block text-muted-foreground">{detail}</span>
      </span>
      {action}
    </li>
  )
}

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"
const ACTION = "h-auto min-h-11 p-0 sm:min-h-8"

/** «El modelo responde»: el servidor hace una llamada mínima y la guarda 10 minutos. */
export const AGENT_MODEL_QUERY_KEY = ["agent-model"] as const

/**
 * Encender a Sofi: cinco comprobaciones (lo que falta lleva a donde se
 * resuelve). Lo que puede hacer lo dicen sus funciones, en la página; no hay
 * niveles que elegir (ADR 0021). El canal y el modelo impiden encender: sin
 * canal no le llega ningún mensaje y, sin un modelo que responda, cada
 * paciente recibiría «una persona te va a responder». El servidor también
 * rechaza encender sin un modelo que responda. Las otras tres solo avisan.
 */
export function TurnOnDrawer({
  open,
  onClose,
  overview,
  onTest,
}: {
  open: boolean
  onClose: () => void
  overview: AgentOverview
  /** Lleva a «Probar» sin perder el encendido a medias. */
  onTest: () => void
}) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const model = useQuery({
    queryKey: AGENT_MODEL_QUERY_KEY,
    queryFn: () => apiFetch<{ data: AgentModelStatus }>("/api/agent/model"),
    enabled: open,
    retry: false,
    // El servidor ya guarda el resultado 10 minutos: reabrir el cajón no repite la llamada.
    staleTime: 60_000,
  })
  const recheck = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: AgentModelStatus }>("/api/agent/model?fresh=1"),
    onSuccess: (fresh) => queryClient.setQueryData(AGENT_MODEL_QUERY_KEY, fresh),
  })
  const turnOn = useMutation({
    retry: false,
    mutationFn: () => apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ enabled: true }) }),
    onSuccess: () => {
      for (const key of ["agent-config", "agent-overview", "agent-summary"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      onClose()
    },
    // El servidor rechazó encender: lo que dice el modelo pudo cambiar.
    onError: () => void queryClient.invalidateQueries({ queryKey: AGENT_MODEL_QUERY_KEY }),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!turnOn.isPending) turnOn.mutate()
  }

  const { readiness, knows } = overview
  const hasChannel = readiness.channels.length > 0
  const checking = model.isFetching || (open && model.isPending && !model.isError) || recheck.isPending
  const status = model.data?.data
  // Sin respuesta del servidor no se culpa al modelo: es la conexión.
  const unreachable = !checking && (recheck.isError || model.isError || !status)
  const modelOk = !checking && !unreachable && status?.responds === true
  const recheckAction = (
    <Button type="button" variant="link" size="sm" className={ACTION} onClick={() => recheck.mutate()}>
      Volver a comprobar
    </Button>
  )
  let modelDetail: string = MODEL_CHECK_TEXT.checking
  let modelAction: ReactNode
  if (!checking) {
    if (unreachable || !status) {
      modelDetail = MODEL_CHECK_TEXT.unreachable
      modelAction = recheckAction
    } else if (status.responds) {
      modelDetail = `Responde · ${AGENT_MODEL_LABEL}`
    } else {
      modelDetail = MODEL_CHECK_TEXT.down
      modelAction = recheckAction
    }
  }
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        turnOn.reset()
        onClose()
      }}
      title={`Encender a ${receptionName}`}
      description="Cinco comprobaciones. Lo que falta te lleva a donde se resuelve."
      onSubmit={submit}
      isSubmitting={turnOn.isPending}
      // El 409 `MODEL_NOT_RESPONDING` trae su explicación: se dice tal cual, junto al botón.
      error={turnOn.isError ? submitErrorMessage(turnOn.error) : null}
      submitLabel={`Encender a ${receptionName}`}
      cancelLabel="Ahora no"
      submitDisabled={!hasChannel || !modelOk}
    >
      <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-2">
        <Check
          ok={hasChannel}
          title="Un canal conectado"
          detail={
            hasChannel
              ? readiness.channels.map((channel) => channelLabel(channel)).join(", ")
              : "Sin un canal conectado no le llega ningún mensaje."
          }
          action={
            hasChannel ? undefined : (
              <Link to="/settings/integrations" className={LINK}>
                Conectar un canal
              </Link>
            )
          }
        />
        <Check ok={modelOk} checking={checking} title="El modelo responde" detail={modelDetail} action={modelAction} />
        {/* Lo que dice sale de los datos (ADR 0120): sin horario del equipo ni servicios no sabe cuándo atiende ni qué hace. */}
        <Check
          ok={knows.branchesWithHours > 0 && knows.services > 0}
          title="Sabe tu horario y tus servicios"
          detail={
            knows.branchesWithHours === 0
              ? "Nadie del equipo tiene horario: no puede decir cuándo atiende. Puedes encender así."
              : knows.services === 0
                ? "No hay servicios activos: no puede decir qué hace la clínica. Puedes encender así."
                : "Los lee de tus datos en el momento. Lo que no sepa, lo dice y lo pasa a una persona."
          }
          action={
            knows.branchesWithHours === 0 ? (
              <Link to="/settings/availability" className={LINK}>
                Cargar horarios
              </Link>
            ) : knows.services === 0 ? (
              <Link to="/services" className={LINK}>
                Agregar servicios
              </Link>
            ) : undefined
          }
        />
        <Check
          ok={readiness.sandboxTurns > 0}
          title="Lo probaste"
          detail={
            readiness.sandboxTurns > 0
              ? `${readiness.sandboxTurns} ${readiness.sandboxTurns === 1 ? "mensaje de prueba respondido" : "mensajes de prueba respondidos"}`
              : "Todavía no le escribiste ninguna prueba."
          }
          action={
            <Button type="button" variant="link" size="sm" className={ACTION} onClick={onTest}>
              {readiness.sandboxTurns > 0 ? "Probar otra" : "Probar"}
            </Button>
          }
        />
        <Check
          ok={readiness.receivers.length > 0}
          title="Alguien recibe lo que pasa a una persona"
          detail={
            readiness.receivers.length > 0
              ? readiness.receivers.join(", ")
              : "Nadie de tu equipo puede tomar los casos que pase."
          }
          action={
            readiness.receivers.length > 0 ? undefined : (
              <Link to="/settings/team" className={LINK}>
                Invitar a alguien
              </Link>
            )
          }
        />
      </ul>

      <p className="text-sm text-muted-foreground">El canal y el modelo impiden encender; lo demás avisa.</p>
      <p className="text-sm text-muted-foreground">Responde siempre al momento. Antes de reservar, mover o cancelar una cita le pide el «sí» al paciente. Lo apagas cuando quieras; lo que esté a medias pasa a tu equipo.</p>
      </div>
    </FormDrawer>
  )
}
