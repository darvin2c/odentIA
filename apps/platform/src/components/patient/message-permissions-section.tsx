import { Button, cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCan } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import type { PatientFull } from "../../lib/patients"

type Purpose = "recordatorio" | "seguimiento"
type How = "presencial" | "conversacion"

interface MessagePermission {
  purpose: Purpose
  granted: boolean | null
  source: string | null
  at: string | null
}

const ROWS: { purpose: Purpose; label: string; hint?: string }[] = [
  { purpose: "recordatorio", label: "Recordatorios de citas y controles" },
  { purpose: "seguimiento", label: "Otros mensajes de la clínica", hint: "Inasistencias y presupuestos pendientes." },
]

const HOW: { id: How; label: string }[] = [
  { id: "presencial", label: "En persona" },
  { id: "conversacion", label: "Por la conversación" },
]

/** Cómo quedó registrado, con las palabras de la pantalla. */
const ACCEPTED: Record<string, string> = {
  registro: "Lo aceptó al registrarse",
  presencial: "Lo aceptó en persona",
  conversacion: "Lo aceptó por la conversación",
  portal: "Lo aceptó en el portal",
}
const DECLINED: Record<string, string> = {
  registro: "No lo aceptó al registrarse",
  presencial: "Dijo en persona que no",
  conversacion: "Dijo por la conversación que no",
  portal: "No lo aceptó en el portal",
  baja: "Se dio de baja desde un mensaje",
  revocacion_datos: "Se retiró al revocar su consentimiento de datos",
}

function describe(row: MessagePermission): string {
  if (row.granted === null || !row.at) return "No se le ha preguntado."
  const when = new Date(row.at).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "long" })
  const words = (row.granted ? ACCEPTED : DECLINED)[row.source ?? ""] ?? (row.granted ? "Lo aceptó" : "No lo aceptó")
  return `${words}, el ${when}.`
}

/** A quién se le escribe lo de este paciente: su persona preferida o él mismo. */
export function messageRecipientOf(detail: PatientFull) {
  const active = detail.contacts.filter((contact) => contact.isActive)
  return active.find((contact) => contact.isPreferred) ?? active.find((contact) => contact.relationship === "self") ?? null
}

/**
 * Lo que la persona aceptó recibir sin haber escrito primero. No es un permiso
 * aparte: son las finalidades de mensajes del consentimiento de datos, y aquí
 * se ven y se corrigen cuando lo dice en persona o por la conversación.
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

  return (
    <div className="flex flex-col gap-2 border-t pt-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">Mensajes de la clínica</p>
      <p className="text-muted-foreground">
        Lo que {recipientName ? `${recipientName} aceptó` : "aceptó"} recibir sin haber escrito primero.
      </p>
      {query.isPending ? (
        <LoadingState message="Cargando lo que aceptó recibir…" />
      ) : query.isError ? (
        <ErrorState title="No se pudo cargar lo que aceptó recibir" onRetry={() => void query.refetch()} />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {ROWS.map((item) => {
            const row = rows.find((candidate) => candidate.purpose === item.purpose) ?? {
              purpose: item.purpose,
              granted: null,
              source: null,
              at: null,
            }
            const open = editing?.purpose === item.purpose
            const labelId = `${uid}-${item.purpose}`
            const howId = `${uid}-${item.purpose}-como`
            return (
              <li key={item.purpose} className="flex flex-col gap-3 p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div id={labelId} className="font-medium">
                      {item.label}
                    </div>
                    {item.hint ? <div className="text-muted-foreground">{item.hint}</div> : null}
                    <div className="text-muted-foreground">{describe(row)}</div>
                  </div>
                  <Switch
                    aria-labelledby={labelId}
                    checked={open ? editing.granted : row.granted === true}
                    disabled={!canWrite || save.isPending}
                    onCheckedChange={(granted: boolean) => {
                      save.reset()
                      // Volver al estado guardado cancela el cambio que estaba a medias.
                      setEditing(granted === (row.granted === true) ? null : { purpose: item.purpose, granted, how: "presencial" })
                    }}
                  />
                </div>
                {open ? (
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
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-muted-foreground">
        Se le escribe por WhatsApp o, si no tiene, por correo. Puede darse de baja con un toque desde cualquier mensaje.
      </p>
    </div>
  )
}
