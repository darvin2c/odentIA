import { Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { AgentMark, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { apiFetch } from "../../lib/api"
import { timeAgo, useCan, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import type { PersonNote } from "../../lib/people"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { SummaryCard } from "../patient/resumen-tab"

interface MemoryFact {
  id: string
  text: string
  source: "agente" | "equipo"
  createdByName: string | null
  createdAt: string
}

interface MemoryView {
  facts: MemoryFact[]
  derived: Array<{ text: string; origin: string }>
}

/**
 * El único sitio de las notas de una persona (ADR 0029), con quién las
 * escribió: las de «Contexto» en la Bandeja y lo que quedó escrito antes en
 * los datos del contacto. Son inmutables: una corrección es otra nota. La nota
 * clínica sigue en la historia. Las lee y escribe quien lleva el CRM.
 */
export function PersonNotes({ personId }: { personId: string }) {
  const canRead = usePermission("crm.read")
  const canWrite = usePermission("crm.write")
  const queryClient = useQueryClient()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState("")
  const notes = useQuery({
    queryKey: ["person-notes", personId],
    queryFn: () => apiFetch<{ data: PersonNote[] }>(`/api/people/${personId}/notes`),
    enabled: canRead,
    retry: false,
  })
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/people/${personId}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: body.trim() }),
      }),
    onSuccess: () => {
      setBody("")
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["person-notes", personId] })
      void queryClient.invalidateQueries({ queryKey: ["crm-activity", personId] })
    },
  })
  if (!canRead) return null
  const list = notes.data?.data ?? []
  return (
    <SummaryCard
      title="Notas"
      action={
        canWrite ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              save.reset()
              setOpen(true)
            }}
          >
            Nueva nota
          </Button>
        ) : undefined
      }
    >
      {notes.isPending ? (
        <LoadingState message="Cargando notas…" />
      ) : notes.isError && list.length === 0 ? (
        <QueryErrorState error={notes.error} onRetry={() => void notes.refetch()} />
      ) : list.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Sin notas. Lo que el equipo anote de esta persona (una llamada, un acuerdo) queda aquí
            con quién lo escribió.
          </p>
          {canWrite ? (
            <Button type="button" size="sm" onClick={() => setOpen(true)}>
              Escribir la primera nota
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col divide-y">
          {list.map((note) => (
            <li key={note.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <span className="text-xs text-muted-foreground">
                {`${note.authorName ?? "Anotado por odentIA"} · ${timeAgo(note.at) || new Date(note.at).toLocaleDateString(activeOrgLocale())}`}
              </span>
              <span className="whitespace-pre-wrap text-sm">{note.body}</span>
            </li>
          ))}
        </ul>
      )}
      <FormDrawer
        open={open}
        onClose={() => {
          if (!save.isPending) setOpen(false)
        }}
        title="Nueva nota"
        description="Queda con tu nombre y no se puede editar: una corrección va en otra nota. Lo clínico se anota en la historia."
        onSubmit={(event) => {
          event.preventDefault()
          if (body.trim()) save.mutate()
        }}
        isSubmitting={save.isPending}
        isDirty={body.trim().length > 0}
        submitDisabled={!body.trim()}
        submitLabel="Guardar nota"
        error={save.isError ? mutationErrorMessage(save.error) : null}
      >
        <Field>
          <FieldLabel htmlFor={id}>Nota</FieldLabel>
          <Textarea
            id={id}
            value={body}
            rows={5}
            maxLength={4000}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </SummaryCard>
  )
}

/**
 * Lo que recuerda el agente de la persona, aparte de las notas y solo para
 * leer: se corrige desde «Contexto» en la Bandeja. Nada clínico.
 */
export function PersonAgentMemory({ personId }: { personId: string }) {
  const can = useCan()
  const canRead = can("conversations.read") || can("crm.read")
  const memory = useQuery({
    queryKey: ["agent-person-memory", personId],
    queryFn: () => apiFetch<{ data: MemoryView }>(`/api/contacts/${personId}/agent-memory`),
    enabled: canRead,
    retry: false,
  })
  if (!canRead) return null
  const facts = memory.data?.data.facts ?? []
  const derived = memory.data?.data.derived ?? []
  return (
    <section
      aria-label="Lo que recuerda el agente"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-agent-border bg-agent-soft p-6"
    >
      <div className="flex items-center gap-2">
        <AgentMark size="sm" />
        <h2 className="font-heading text-base font-medium">Lo que recuerda el agente</h2>
      </div>
      {memory.isPending ? (
        <LoadingState message="Cargando…" />
      ) : memory.isError ? (
        <QueryErrorState error={memory.error} onRetry={() => void memory.refetch()} />
      ) : facts.length === 0 && derived.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no recuerda nada de esta persona.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {facts.map((fact) => (
            <li key={fact.id}>
              {fact.text}
              <span className="text-xs text-muted-foreground">
                {" "}
                ·{" "}
                {fact.source === "equipo"
                  ? `lo anotó ${fact.createdByName ?? "el equipo"}`
                  : "lo dijo la persona"}
              </span>
            </li>
          ))}
          {derived.map((item) => (
            <li key={`${item.origin}:${item.text}`} className="text-muted-foreground">
              {item.text}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Solo se lee aquí; se corrige desde «Contexto» en la Bandeja.
      </p>
    </section>
  )
}
