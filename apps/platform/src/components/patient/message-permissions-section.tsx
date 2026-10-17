import { Button, cn, FieldLabel, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ConfirmDialog, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useCan } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import type { PatientFull } from "../../lib/patients"

type Purpose = "recordatorio" | "seguimiento" | "novedades" | "avisos"
/** Un interruptor, o «ningún mensaje». */
type Choice = "recordatorio" | "seguimiento" | "novedades" | "ninguno"
type How = "presencial" | "telefono" | "conversacion"

interface MessagePermission {
  purpose: Purpose
  granted: boolean | null
  source: string | null
  at: string | null
}

/**
 * Los tres tipos que la persona puede apagar, con los mismos nombres que ve en
 * «Tus mensajes» (ADR 0040). Recordatorios y seguimiento llegan sin pedir
 * permiso hasta que los apaga; las novedades, solo con su sí.
 */
const SWITCHES: { purpose: Exclude<Choice, "ninguno">; title: string; detail: string }[] = [
  { purpose: "recordatorio", title: "Recordatorios de sus citas", detail: "Un día antes y unas horas antes." },
  { purpose: "seguimiento", title: "Controles y seguimiento", detail: "Cuándo le toca su control, o si faltó a una cita." },
  { purpose: "novedades", title: "Novedades y promociones", detail: "Campañas y ofertas de la clínica: solo si lo aceptó." },
]

const HOW: { id: How; label: string }[] = [
  { id: "presencial", label: "En persona" },
  { id: "telefono", label: "Por teléfono" },
  { id: "conversacion", label: "Por la conversación" },
]

/** Cómo quedó registrado, con las palabras de la pantalla. */
const SAID: Record<string, string> = {
  registro: "al registrarse",
  presencial: "en persona",
  telefono: "por teléfono",
  conversacion: "por la conversación",
  portal: "en el portal",
  enlace: "en su enlace",
  baja: "desde un mensaje",
  revocacion_datos: "al revocar su consentimiento de datos",
}

function dayOf(at: string | null): string | null {
  return at ? new Date(at).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short" }) : null
}

/** «Encendido» o «Apagado · lo pidió por teléfono · 15 oct». */
function stateOf(row: MessagePermission, on: boolean): string {
  const when = dayOf(row.at)
  const how = row.source ? SAID[row.source] : null
  if (row.granted === null || !when) return on ? "Encendido" : "Apagado: aún no lo aceptó"
  return [on ? "Encendido" : "Apagado", how ? `lo dijo ${how}` : null, when].filter(Boolean).join(" · ")
}

/** A quién se le escribe lo de este paciente: su persona preferida o él mismo. */
export function messageRecipientOf(detail: PatientFull) {
  const active = detail.contacts.filter((contact) => contact.isActive)
  return active.find((contact) => contact.isPreferred) ?? active.find((contact) => contact.relationship === "self") ?? null
}

/**
 * «Tus mensajes» desde la página de la persona (ADR 0040): los mismos tres
 * interruptores que ella ve en su enlace, la fila fija de los avisos de sus
 * citas y papeles, y «No quiere ningún mensaje de la clínica», que también
 * apaga los avisos. Recepción anota aquí lo que la persona pide por teléfono,
 * en persona o por la conversación: cada cambio pide antes cómo lo dijo.
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
  // El cambio a medias: antes de guardar se pide cómo lo dijo la persona.
  const [editing, setEditing] = useState<{ choice: Choice; receive: boolean; how: How } | null>(null)
  const [confirmNothing, setConfirmNothing] = useState(false)
  const save = useMutation({
    mutationFn: (input: { choice: Choice; receive: boolean; how: How }) =>
      apiFetch<{ data: MessagePermission[] }>(`/api/agent/admin/people/${contactId}/permissions`, {
        method: "POST",
        body: JSON.stringify({ tipo: input.choice, recibir: input.receive, source: input.how }),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(key, result)
      setEditing(null)
      setConfirmNothing(false)
    },
  })
  if (!contactId) return null
  const rows = query.data?.data ?? []
  const error = save.error instanceof ApiError ? (save.error.shape.message ?? "No se pudo guardar") : save.error ? "No se pudo guardar" : null

  const rowOf = (purpose: Purpose): MessagePermission =>
    rows.find((candidate) => candidate.purpose === purpose) ?? { purpose, granted: null, source: null, at: null }
  const nothing = rowOf("avisos").granted === false
  /** Lo que llega hoy: recordatorios y seguimiento hasta que los apaga; novedades solo con su sí. */
  const isOn = (purpose: Exclude<Choice, "ninguno">) => {
    if (nothing) return false
    const granted = rowOf(purpose).granted
    return purpose === "novedades" ? granted === true : granted !== false
  }
  const howId = `${uid}-como`
  const who = recipientName ?? "la persona"

  /** Cómo lo dijo, antes de guardar un cambio. */
  const howChooser = (choice: Choice) =>
    editing && editing.choice === choice ? (
      <div className="flex flex-col gap-2">
        <span id={howId} className="font-medium">
          {editing.receive ? "¿Cómo lo pidió?" : "¿Cómo pidió dejar de recibirlos?"}
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
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => (editing.choice === "ninguno" && !editing.receive ? setConfirmNothing(true) : save.mutate(editing))}
          >
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
        Lo que {recipientName ? `${recipientName} recibe` : "recibe"} sin haber escrito primero. Son los mismos interruptores
        que ve en su enlace, en «Tus mensajes».
      </p>
      {query.isPending ? (
        <LoadingState message="Cargando sus mensajes…" />
      ) : query.isError ? (
        <ErrorState title="No se pudo cargar lo que recibe" onRetry={() => void query.refetch()} />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {nothing ? (
            <li className="flex flex-col gap-2 p-3">
              <div className="font-medium">No recibe ningún mensaje de la clínica</div>
              <div className="text-muted-foreground">
                Tampoco los avisos de sus citas y papeles
                {rowOf("avisos").source ? ` · lo dijo ${SAID[rowOf("avisos").source ?? ""] ?? ""}` : ""}
                {dayOf(rowOf("avisos").at) ? ` · ${dayOf(rowOf("avisos").at)}` : ""}. Si hay que avisarle algo, llámala.
              </div>
              {canWrite && editing?.choice !== "ninguno" ? (
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() => {
                      save.reset()
                      setEditing({ choice: "ninguno", receive: true, how: "presencial" })
                    }}
                  >
                    Volver a enviarle mensajes
                  </Button>
                </div>
              ) : null}
              {howChooser("ninguno")}
            </li>
          ) : null}
          {SWITCHES.map((item) => {
            const labelId = `${uid}-${item.purpose}`
            const on = isOn(item.purpose)
            return (
              <li key={item.purpose} className="flex flex-col gap-3 p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div id={labelId} className="font-medium">
                      {item.title}
                    </div>
                    <div className="text-muted-foreground">{item.detail}</div>
                    <div className="text-muted-foreground">{stateOf(rowOf(item.purpose), on)}</div>
                  </div>
                  <Switch
                    aria-labelledby={labelId}
                    checked={editing?.choice === item.purpose ? editing.receive : on}
                    disabled={!canWrite || save.isPending}
                    onCheckedChange={(receive: boolean) => {
                      save.reset()
                      // Volver al estado guardado cancela el cambio que estaba a medias.
                      setEditing(receive === on ? null : { choice: item.purpose, receive, how: "telefono" })
                    }}
                  />
                </div>
                {howChooser(item.purpose)}
              </li>
            )
          })}
          <li className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Avisos de sus citas y papeles</div>
              <div className="text-muted-foreground">
                Si su cita se reserva, cambia o se cancela, y cuando su presupuesto o su receta están listos. Son parte de su
                atención.
              </div>
            </div>
            <span className="shrink-0 font-medium">{nothing ? "No" : "Siempre"}</span>
          </li>
        </ul>
      )}
      {!nothing && canWrite && !query.isPending && !query.isError ? (
        <div className="flex flex-col gap-2">
          {editing?.choice === "ninguno" ? (
            howChooser("ninguno")
          ) : (
            <Button
              variant="link"
              className="h-auto self-start p-0 text-destructive"
              disabled={save.isPending}
              onClick={() => {
                save.reset()
                setEditing({ choice: "ninguno", receive: false, how: "telefono" })
              }}
            >
              No quiere ningún mensaje de la clínica
            </Button>
          )}
        </div>
      ) : null}
      <p className="text-muted-foreground">
        Se le escribe por WhatsApp o, si no tiene, por correo. Puede elegirlos ella misma desde su enlace o desde cualquier
        mensaje.
      </p>
      <ConfirmDialog
        open={confirmNothing}
        onClose={() => setConfirmNothing(false)}
        title={`¿${who} no quiere ningún mensaje de la clínica?`}
        description="Dejarán de llegarle también los avisos de sus citas y papeles: si su cita cambia, habrá que llamarla. Lo verás en su página."
        confirmLabel="Sí, no enviarle nada"
        pending={save.isPending}
        onConfirm={() => {
          if (editing) save.mutate(editing)
        }}
      />
    </div>
  )
}
