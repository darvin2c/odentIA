import { Button, cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCan } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import type { PatientFull } from "../../lib/patients"

type Purpose = "recordatorio" | "seguimiento" | "novedades"
type How = "presencial" | "telefono" | "conversacion"

interface MessagePermission {
  purpose: Purpose
  granted: boolean | null
  source: string | null
  at: string | null
}

/**
 * Lo que es parte del servicio que pidió (su cita, sus controles, sus
 * presupuestos y seguimientos) no pide permiso: solo deja de salir si se dio de
 * baja de ese tipo. Solo novedades y promociones pide su permiso (ADR 0030).
 */
const SERVICE: { purpose: Purpose; what: string }[] = [
  { purpose: "recordatorio", what: "los recordatorios de sus citas y controles" },
  { purpose: "seguimiento", what: "los mensajes de sus presupuestos y seguimientos" },
]

const HOW: { id: How; label: string }[] = [
  { id: "presencial", label: "En persona" },
  { id: "telefono", label: "Por teléfono" },
  { id: "conversacion", label: "Por la conversación" },
]

/** Cómo quedó registrado, con las palabras de la pantalla. */
const ACCEPTED: Record<string, string> = {
  registro: "aceptó al registrarse",
  presencial: "aceptó en persona",
  telefono: "aceptó por teléfono",
  conversacion: "aceptó por la conversación",
  portal: "aceptó en el portal",
}
const DECLINED: Record<string, string> = {
  registro: "no lo aceptó al registrarse",
  presencial: "dijo en persona que no",
  telefono: "dijo por teléfono que no",
  conversacion: "dijo por la conversación que no",
  portal: "no lo aceptó en el portal",
  baja: "se dio de baja desde un mensaje",
  revocacion_datos: "se retiró al revocar su consentimiento de datos",
}

function dayOf(at: string | null): string | null {
  return at ? new Date(at).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short" }) : null
}

/** «Sí · aceptó por teléfono · 15 oct». */
function describeNews(row: MessagePermission): string {
  const when = dayOf(row.at)
  if (row.granted === null || !when) return "No se le ha preguntado."
  const words = (row.granted ? ACCEPTED : DECLINED)[row.source ?? ""] ?? (row.granted ? "lo aceptó" : "no lo aceptó")
  return `${row.granted ? "Sí" : "No"} · ${words} · ${when}`
}

/** A quién se le escribe lo de este paciente: su persona preferida o él mismo. */
export function messageRecipientOf(detail: PatientFull) {
  const active = detail.contacts.filter((contact) => contact.isActive)
  return active.find((contact) => contact.isPreferred) ?? active.find((contact) => contact.relationship === "self") ?? null
}

/**
 * Lo que la persona recibe sin haber escrito primero. Lo de su atención es
 * parte del servicio y solo deja de salir si se dio de baja (se ve aquí y se
 * puede deshacer); novedades y promociones es la finalidad de mensajes del
 * consentimiento de datos, y aquí se ve y se corrige cuando lo dice en persona,
 * por teléfono o por la conversación (ADR 0030).
 */
export function MessagePermissionsSection({
  contactId,
  recipientName,
}: {
  contactId: string | null | undefined
  /** Quien recibe los mensajes si no es la propia persona (el tutor de un menor). */
  recipientName?: string | null
}): React.JSX.Element | null {
  const uid = useId()
  const can = useCan()
  const canWrite = can("patients.write") || can("crm.write")
  const queryClient = useQueryClient()
  const key = ["message-permissions", contactId]
  const query = useQuery({
    queryKey: key,
    enabled: !!contactId,
    queryFn: () => apiFetch<{ data: MessagePermission[] }>(`/api/agent/admin/people/${contactId}/permissions`),
  })
  // Fila que se está cambiando: el interruptor pide antes cómo lo dijo la persona.
  const [editing, setEditing] = useState<{ purpose: Purpose; granted: boolean; how: How } | null>(null)
  const save = useMutation({
    mutationFn: (input: { purpose: Purpose; granted: boolean; how: How }) =>
      apiFetch<{ data: MessagePermission[] }>(`/api/agent/admin/people/${contactId}/permissions`, {
        method: "POST",
        body: JSON.stringify({ purpose: input.purpose, granted: input.granted, source: input.how }),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(key, result)
      setEditing(null)
    },
  })
  if (!contactId) return null
  const rows = query.data?.data ?? []
  const error = save.error instanceof ApiError ? (save.error.shape.message ?? "No se pudo guardar") : save.error ? "No se pudo guardar" : null

  const rowOf = (purpose: Purpose): MessagePermission =>
    rows.find((candidate) => candidate.purpose === purpose) ?? { purpose, granted: null, source: null, at: null }
  const news = rowOf("novedades")
  const optedOut = SERVICE.map((item) => ({ ...item, row: rowOf(item.purpose) })).filter((item) => item.row.granted === false)
  const newsLabelId = `${uid}-novedades`
  const howId = `${uid}-como`

  /** Cómo lo dijo, antes de guardar un cambio. */
  const howChooser = editing ? (
    <div className="flex flex-col gap-2">
      <span id={howId} className="font-medium">
        {editing.granted ? "¿Cómo lo aceptó?" : "¿Cómo lo dijo?"}
      </span>
      <RadioGroup
        aria-labelledby={howId}
        className="flex flex-wrap gap-2"
        value={editing.how}
        onValueChange={(how) => setEditing({ ...editing, how: how as How })}
      >
        {HOW.map((option) => (
          <FieldLabel
            key={option.id}
            className={cn(
              "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
              editing.how === option.id && "border-primary bg-primary-soft",
            )}
          >
            <RadioGroupItem value={option.id} />
            {option.label}
          </FieldLabel>
        ))}
      </RadioGroup>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(editing)}>
          {save.isPending ? "Guardando…" : "Guardar"}
        </Button>
        <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setEditing(null)}>
          Cancelar
        </Button>
      </div>
    </div>
  ) : null

  return (
    <div className="flex flex-col gap-2 border-t pt-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">Mensajes de la clínica</p>
      <p className="text-muted-foreground">
        Lo que {recipientName ? `${recipientName} recibe` : "recibe"} sin haber escrito primero: lo de su atención es parte
        del servicio; las novedades y promociones, solo si lo aceptó.
      </p>
      {query.isPending ? (
        <LoadingState message="Cargando lo que aceptó recibir…" />
      ) : query.isError ? (
        <ErrorState title="No se pudo cargar lo que aceptó recibir" onRetry={() => void query.refetch()} />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          <li className="flex flex-col gap-2 p-3">
            <div className="font-medium">Atención (citas, controles, presupuestos)</div>
            <div className="text-muted-foreground">Parte del servicio: no pide permiso.</div>
            {optedOut.map((item) => (
              <div key={item.purpose} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-muted-foreground">
                  Pidió no recibir {item.what} · {DECLINED[item.row.source ?? ""] ?? "lo pidió"}
                  {dayOf(item.row.at) ? ` · ${dayOf(item.row.at)}` : ""}
                </span>
                {canWrite && editing?.purpose !== item.purpose ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() => {
                      save.reset()
                      setEditing({ purpose: item.purpose, granted: true, how: "presencial" })
                    }}
                  >
                    Volver a enviárselos
                  </Button>
                ) : null}
              </div>
            ))}
            {editing && editing.purpose !== "novedades" ? howChooser : null}
          </li>
          <li className="flex flex-col gap-3 p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div id={newsLabelId} className="font-medium">
                  Novedades y promociones
                </div>
                <div className="text-muted-foreground">{describeNews(news)}</div>
              </div>
              <Switch
                aria-labelledby={newsLabelId}
                checked={editing?.purpose === "novedades" ? editing.granted : news.granted === true}
                disabled={!canWrite || save.isPending}
                onCheckedChange={(granted: boolean) => {
                  save.reset()
                  // Volver al estado guardado cancela el cambio que estaba a medias.
                  setEditing(granted === (news.granted === true) ? null : { purpose: "novedades", granted, how: "presencial" })
                }}
              />
            </div>
            {editing?.purpose === "novedades" ? howChooser : null}
          </li>
        </ul>
      )}
      <p className="text-muted-foreground">
        Se le escribe por WhatsApp o, si no tiene, por correo. Puede darse de baja con un toque desde cualquier mensaje.
      </p>
    </div>
  )
}
