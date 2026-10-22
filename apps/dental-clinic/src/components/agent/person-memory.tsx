import { Button, Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { DetailDrawer, DetailSection, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Lock, Plus, X } from "lucide-react"
import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useReceptionName } from "../../lib/agent-names"
import { channelLabel } from "../../lib/channels"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

interface PersonFact {
  id: string
  text: string
  source: "agente" | "equipo"
  channel: string | null
  createdByName: string | null
  createdAt: string
}

interface PersonLastTime {
  timezone: string
  locale: string
  wrote: { at: string; channel: string } | null
  appointment: { startsAt: string; status: string; upcoming: boolean; branchName: string; dentistName: string | null } | null
  handoff: { at: string; reason: string | null } | null
}

interface PersonMemory {
  contactId: string
  facts: PersonFact[]
  derived: Array<{ text: string; origin: string; managedIn: "ficha" | "agenda" }>
  lastTime: PersonLastTime
}

type Zone = Pick<PersonLastTime, "timezone" | "locale">

/** Qué se está escribiendo: un dato nuevo o la corrección de uno (el nuevo lo reemplaza). */
type Editing = { mode: "add" } | { mode: "fix"; fact: PersonFact }

const dayOf = (iso: string, zone: Zone) =>
  new Date(iso).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })

function origin(fact: PersonFact, zone: Zone): string {
  const day = dayOf(fact.createdAt, zone)
  if (fact.source === "equipo") return `Lo anotó ${fact.createdByName ?? "tu equipo"} el ${day}`
  return `Lo dijo${fact.channel ? ` por ${channelLabel(fact.channel)}` : ""} el ${day}`
}

/** Dónde se cambia lo que no se guarda aquí: sale de la ficha o de la agenda. */
const MANAGED_IN: Record<PersonMemory["derived"][number]["managedIn"], string> = {
  ficha: "se cambia en su ficha",
  agenda: "sale de su agenda y cambia con sus citas",
}

/** «La última vez», con lo que entrega el servidor: cuándo escribió, su cita y si su caso pasó a una persona. */
function lastTimeLines(last: PersonLastTime): string[] {
  const lines: string[] = []
  if (last.wrote) lines.push(`Escribió por última vez el ${dayOf(last.wrote.at, last)} por ${channelLabel(last.wrote.channel)}.`)
  if (last.appointment) {
    const visit = last.appointment
    const at = new Date(visit.startsAt)
    const date = at.toLocaleDateString(last.locale, { timeZone: last.timezone, weekday: "long", day: "numeric", month: "long" })
    const time = at.toLocaleTimeString(last.locale, { timeZone: last.timezone, hour: "2-digit", minute: "2-digit" })
    const where = `en la sede ${visit.branchName}${visit.dentistName ? ` con ${visit.dentistName}` : ""}`
    if (visit.upcoming) lines.push(`Su próxima cita es el ${date} a las ${time}, ${where}.`)
    else if (visit.status === "no_asistio") lines.push(`No vino a su cita del ${date} a las ${time}, ${where}.`)
    else if (visit.status === "atendida") lines.push(`Su última cita fue el ${date} a las ${time}, ${where}.`)
    else lines.push(`Tenía cita el ${date} a las ${time}, ${where}.`)
  }
  if (last.handoff) {
    lines.push(`El ${dayOf(last.handoff.at, last)} su caso pasó a una persona del equipo${last.handoff.reason ? `: ${last.handoff.reason}` : ""}.`)
  }
  return lines
}

/** El rechazo por dato de salud trae su propia explicación; lo demás usa el mensaje común. */
function saveError(error: unknown): string | null {
  if (error instanceof ApiError && error.status === 400 && error.shape.message) return error.shape.message
  if (error instanceof ApiError && error.status === 409 && error.shape.message) return error.shape.message
  return mutationErrorMessage(error)
}

/**
 * Lo que el agente recuerda de una persona, además de sus conversaciones: unos
 * pocos datos prácticos con fecha y origen. Se corrigen (tocando el dato) o se
 * quitan aquí; lo que sale de vínculos y citas se cambia en su fuente y por eso
 * no lleva botón. Nunca nada clínico.
 */
export function PersonMemoryDrawer({
  contactId,
  name,
  canWrite,
  onClose,
}: {
  /** La persona; null = cerrado. */
  contactId: string | null
  name: string
  canWrite: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const baseId = useId()
  const [draft, setDraft] = useState("")
  const [editing, setEditing] = useState<Editing | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  /** Al cerrar el campo de un dato nuevo, el foco vuelve al botón que lo abrió. */
  const refocusAdd = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: el borrador se vacía al cambiar de persona.
  useEffect(() => {
    setDraft("")
    setEditing(null)
  }, [contactId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: se ejecuta cuando el campo se cierra.
  useEffect(() => {
    if (editing === null && refocusAdd.current) {
      refocusAdd.current = false
      addButton.current?.focus()
    }
  }, [editing])

  const query = useQuery({
    queryKey: ["agent-person-memory", contactId],
    queryFn: () => apiFetch<{ data: PersonMemory }>(`/api/contacts/${contactId}/agent-memory`),
    enabled: contactId !== null,
    retry: false,
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["agent-person-memory", contactId] })
  const fixing = editing?.mode === "fix" ? editing.fact : null
  function closeEditor() {
    refocusAdd.current = editing?.mode === "add"
    setEditing(null)
    setDraft("")
  }
  const save = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch(`/api/contacts/${contactId}/agent-memory`, {
        method: "POST",
        body: JSON.stringify({ text: draft.trim(), ...(fixing ? { replacesId: fixing.id } : {}) }),
      }),
    onSuccess: () => {
      closeEditor()
      refresh()
    },
  })
  const remove = useMutation({
    retry: false,
    mutationFn: (factId: string) => apiFetch(`/api/contacts/${contactId}/agent-memory/${factId}/remove`, { method: "POST" }),
    onSettled: refresh,
  })

  if (contactId === null) return null
  const memory = query.data?.data
  const clean = draft.trim()
  const changed = editing !== null && clean.length > 0 && clean !== fixing?.text

  function open(next: Editing) {
    save.reset()
    setEditing(next)
    setDraft(next.mode === "fix" ? next.fact.text : "")
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (clean.length >= 3 && changed && !save.isPending) save.mutate()
  }

  const editor = editing ? (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Field>
        <FieldLabel htmlFor={`${baseId}-dato`}>{fixing ? "Corregir el dato" : "Agregar un dato"}</FieldLabel>
        <Input
          id={`${baseId}-dato`}
          // biome-ignore lint/a11y/noAutofocus: el campo aparece porque la persona lo pidió; escribir es el siguiente paso.
          autoFocus
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
        />
        <FieldDescription>
          {fixing
            ? "El nuevo reemplaza al anterior, que queda en la historia."
            : "Algo práctico que servirá otra vez: horario que le viene bien, cómo quiere que la llamen, por quién escribe."}
        </FieldDescription>
      </Field>
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError(save.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton type="submit" pending={save.isPending} disabled={clean.length < 3 || !changed} className="min-h-11 sm:min-h-9">
          {fixing ? "Guardar la corrección" : "Agregar"}
        </SubmitButton>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={save.isPending} onClick={closeEditor}>
          {fixing ? "Dejarlo como estaba" : "Cancelar"}
        </Button>
      </div>
    </form>
  ) : null

  const last = memory ? lastTimeLines(memory.lastTime) : []

  return (
    <DetailDrawer
      open
      title={`Lo que recuerda ${receptionName}`}
      headerContent={
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-heading text-xl font-semibold tracking-tight break-words">{name}</p>
          <p className="text-sm text-muted-foreground">
            Solo esto, además de sus conversaciones.{canWrite ? " Lo puedes corregir o quitar." : ""}
          </p>
        </div>
      }
      onClose={onClose}
      isDirty={changed}
      isSubmitting={save.isPending}
    >
      {query.isPending ? (
        <LoadingState message="Cargando lo que recuerda…" />
      ) : query.isError || !memory ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <DetailSection title="Datos">
            {memory.facts.length === 0 && memory.derived.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Todavía no recuerda nada de esta persona.{canWrite ? " Guarda aquí lo que servirá en su próxima conversación." : ""}
              </p>
            ) : (
              <ul className="flex flex-col divide-y rounded-xl border bg-card text-sm">
                {memory.facts.map((fact) =>
                  fixing?.id === fact.id ? (
                    <li key={fact.id} className="p-3">
                      {editor}
                    </li>
                  ) : (
                    <li key={fact.id} className="flex items-center gap-1 py-1 pr-1 pl-1">
                      {canWrite ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto min-h-11 min-w-0 flex-1 flex-col items-start justify-center gap-0 rounded-lg px-2 py-1.5 text-left font-normal whitespace-normal"
                          aria-label={`Corregir: ${fact.text}`}
                          aria-describedby={`${baseId}-${fact.id}`}
                          onClick={() => open({ mode: "fix", fact })}
                        >
                          <span className="font-semibold break-words">{fact.text}</span>
                          <span id={`${baseId}-${fact.id}`} className="text-muted-foreground">
                            {origin(fact, memory.lastTime)}
                          </span>
                        </Button>
                      ) : (
                        <span className="flex min-w-0 flex-1 flex-col px-2 py-1.5">
                          <span className="font-semibold break-words">{fact.text}</span>
                          <span className="text-muted-foreground">{origin(fact, memory.lastTime)}</span>
                        </span>
                      )}
                      {canWrite ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-11 shrink-0 text-muted-foreground sm:size-9"
                          aria-label={`Quitar: ${fact.text}`}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(fact.id)}
                        >
                          <X aria-hidden />
                        </Button>
                      ) : null}
                    </li>
                  ),
                )}
                {memory.derived.map((item) => (
                  <li key={item.text} className="flex flex-col px-3 py-2.5">
                    <span className="font-semibold break-words">{item.text}</span>
                    <span className="text-muted-foreground">
                      {item.origin} · {MANAGED_IN[item.managedIn]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {remove.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(remove.error)}
              </p>
            ) : null}
            {canWrite && editing?.mode === "add" ? editor : null}
            {canWrite && editing === null ? (
              <Button
                ref={addButton}
                type="button"
                variant="ghost"
                className="min-h-11 self-start px-2 text-primary sm:min-h-9"
                onClick={() => open({ mode: "add" })}
              >
                <Plus aria-hidden />
                Agregar un dato
              </Button>
            ) : null}
          </DetailSection>

          {last.length > 0 ? (
            <DetailSection title="La última vez">
              <div className="flex flex-col gap-1 text-sm">
                {last.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </DetailSection>
          ) : null}

          <div className="flex gap-2.5 rounded-xl bg-muted/60 p-3 text-sm">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="flex flex-col gap-0.5">
              <span className="font-semibold">Nunca guarda</span>
              <span className="text-muted-foreground">Síntomas, diagnósticos ni nada de la historia clínica.</span>
            </p>
          </div>

          <p className="border-t pt-3 text-sm text-muted-foreground">
            Cada dato lleva fecha y origen. Uno nuevo reemplaza al anterior sin borrar la historia.
          </p>
        </div>
      )}
    </DetailDrawer>
  )
}
