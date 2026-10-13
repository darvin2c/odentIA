import { Badge, Button } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { ApiError, apiFetch } from "../lib/api"
import type { ConnectionItem } from "../lib/crm"

type TemplateStatus = "en_revision" | "aprobada" | "rechazada" | "pausada" | "deshabilitada"

interface TemplateItem {
  id: string
  name: string
  language: string
  category: string
  status: TemplateStatus
  reason: string | null
  body: string
  variables: number
  buttons: string[]
  messageKey: string | null
  requestedAt: string | null
  syncedAt: string | null
}

const STATUS: Record<TemplateStatus, { label: string; variant: "success" | "warning" | "destructive" | "secondary"; many: string }> = {
  aprobada: { label: "Aprobado", variant: "success", many: "aprobados" },
  en_revision: { label: "En revisión", variant: "warning", many: "en revisión" },
  rechazada: { label: "Rechazado", variant: "destructive", many: "rechazados" },
  pausada: { label: "Pausado", variant: "warning", many: "pausados" },
  deshabilitada: { label: "Deshabilitado", variant: "secondary", many: "deshabilitados" },
}

const CATEGORY: Record<string, string> = {
  utility: "Utilidad",
  marketing: "Marketing",
  authentication: "Autenticación",
}

/** Para qué sirve cada mensaje que pide odentIA; los demás muestran su nombre. */
const MESSAGE_LABEL: Record<string, string> = {
  recordatorio_cita: "Recordar la cita",
  recordatorio_control: "Avisar un control",
  seguimiento_presupuesto: "Retomar un presupuesto",
  seguimiento_no_asistencia: "Reprogramar tras una inasistencia",
  cita_cancelada: "Ofrecer otra fecha tras una cancelación",
}

/** Qué pasa mientras el mensaje no está aprobado, dicho junto a su estado. */
const CONSEQUENCE: Partial<Record<TemplateStatus, string>> = {
  en_revision: "WhatsApp lo está revisando. Mientras tanto solo sale como respuesta o por correo.",
  rechazada: "No se puede enviar fuera de las 24 horas. Sale como respuesta o por correo.",
  pausada: "WhatsApp lo pausó: no se puede enviar fuera de las 24 horas hasta que lo reactive.",
  deshabilitada: "Ya no sirve para enviar.",
}

function summary(templates: TemplateItem[]): string {
  const order: TemplateStatus[] = ["aprobada", "en_revision", "rechazada", "pausada", "deshabilitada"]
  return order
    .map((status) => [status, templates.filter((template) => template.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => (status === "aprobada" && count === 1 ? "1 aprobado" : `${count} ${STATUS[status].many}`))
    .join(" · ")
}

/**
 * Mensajes de una conexión de WhatsApp con el estado que les da WhatsApp. Se
 * leen de la cuenta: nadie escribe nombres de plantilla. Los que usa el
 * agente los pide odentIA al prender cada cosa.
 */
export function WhatsAppTemplates({
  connection,
  canWrite,
}: {
  connection: ConnectionItem
  canWrite: boolean
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const key = ["connection-templates", connection.id]
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<{ data: TemplateItem[] }>(`/api/channels/connections/${connection.id}/templates/catalog`),
  })
  const sync = useMutation({
    mutationFn: () =>
      apiFetch<{ data: TemplateItem[] }>(`/api/channels/connections/${connection.id}/templates/sync`, { method: "POST" }),
    onSuccess: (result) => queryClient.setQueryData(key, result),
  })
  const templates = query.data?.data ?? []
  const syncError = sync.error instanceof ApiError ? (sync.error.shape.message ?? "No se pudo actualizar") : sync.error ? "No se pudo actualizar" : null

  return (
    <section
      aria-label={`Mensajes aprobados por WhatsApp de ${connection.displayName}`}
      className="flex flex-col gap-3 elevated rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-base font-medium">Mensajes aprobados por WhatsApp</h2>
          <p className="text-sm text-muted-foreground">
            {connection.displayName}
            {templates.length > 0 ? ` · ${summary(templates)}` : ""}
          </p>
        </div>
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw aria-hidden />
            {sync.isPending ? "Actualizando…" : "Actualizar"}
          </Button>
        ) : null}
      </div>
      {syncError ? (
        <p role="alert" className="text-sm text-destructive">
          {syncError}
        </p>
      ) : null}
      {query.isPending ? (
        <LoadingState message="Cargando mensajes…" />
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no hay ninguno. Se leen de tu cuenta de WhatsApp, y los que usa el agente los pide odentIA por ti cuando
          prendes algo que escribe a las personas.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {templates.map((template) => {
            const status = STATUS[template.status]
            const consequence = CONSEQUENCE[template.status]
            return (
              <li key={template.id} className="flex flex-col gap-1 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {template.messageKey ? (MESSAGE_LABEL[template.messageKey] ?? template.name) : template.name}
                  </span>
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <span className="text-muted-foreground">{CATEGORY[template.category] ?? template.category}</span>
                </div>
                {template.body ? <p className="text-muted-foreground">{template.body}</p> : null}
                {template.reason ? <p>Motivo de WhatsApp: {template.reason}</p> : null}
                {consequence ? <p className="text-muted-foreground">{consequence}</p> : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        WhatsApp revisa cada mensaje, decide su categoría y puede rechazarlo. Fuera de las 24 horas desde el último mensaje
        de la persona solo se puede enviar uno aprobado.
      </p>
    </section>
  )
}
