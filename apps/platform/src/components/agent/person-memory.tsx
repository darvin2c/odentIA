import { Button, Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { DetailDrawer, DetailSection, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
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

interface PersonMemory {
  contactId: string
  facts: PersonFact[]
  derived: Array<{ text: string; origin: string }>
}

function origin(fact: PersonFact): string {
  const day = new Date(fact.createdAt).toLocaleDateString("es-PE", { day: "numeric", month: "long" })
  if (fact.source === "equipo") return `Lo anotó ${fact.createdByName ?? "tu equipo"} el ${day}`
  return `Lo dijo${fact.channel ? ` por ${channelLabel(fact.channel)}` : ""} el ${day}`
}

/** El rechazo por dato de salud trae su propia explicación; lo demás usa el mensaje común. */
function saveError(error: unknown): string | null {
  if (error instanceof ApiError && error.status === 400 && error.shape.message) return error.shape.message
  if (error instanceof ApiError && error.status === 409 && error.shape.message) return error.shape.message
  return mutationErrorMessage(error)
}

/**
 * Lo que el agente recuerda de una persona, además de sus conversaciones: unos
 * pocos datos prácticos con fecha y origen. Se corrigen o se quitan aquí; lo
 * que sale de vínculos y citas se cambia en su fuente. Nunca nada clínico.
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
  const [draft, setDraft] = useState("")
  /** Dato que se está corrigiendo: el nuevo lo reemplaza. */
  const [fixing, setFixing] = useState<PersonFact | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: el borrador se vacía al cambiar de persona.
  useEffect(() => {
    setDraft("")
    setFixing(null)
  }, [contactId])

  const query = useQuery({
    queryKey: ["agent-person-memory", contactId],
    queryFn: () => apiFetch<{ data: PersonMemory }>(`/api/contacts/${contactId}/agent-memory`),
    enabled: contactId !== null,
    retry: false,
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["agent-person-memory", contactId] })
  const save = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch(`/api/contacts/${contactId}/agent-memory`, {
        method: "POST",
        body: JSON.stringify({ text: draft.trim(), ...(fixing ? { replacesId: fixing.id } : {}) }),
      }),
    onSuccess: () => {
      setDraft("")
      setFixing(null)
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

  function submit(event: FormEvent) {
    event.preventDefault()
    if (draft.trim().length >= 3 && !save.isPending) save.mutate()
  }

  return (
    <DetailDrawer
      open
      title="Lo que recuerda el agente"
      description={`${name} · solo esto, además de sus conversaciones`}
      onClose={onClose}
      isDirty={draft.trim().length > 0}
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
                Todavía no recuerda nada de esta persona. Guarda aquí lo que servirá en su próxima conversación.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {memory.facts.map((fact) => (
                  <li key={fact.id} className="flex flex-wrap items-start gap-2 rounded-xl border bg-card p-3 text-sm">
                    <span className="min-w-0 flex-1 basis-40">
                      <span className="font-semibold">{fact.text}</span>
                      <span className="block text-muted-foreground">{origin(fact)}</span>
                    </span>
                    {canWrite ? (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-11 sm:min-h-8"
                          aria-label={`Corregir: ${fact.text}`}
                          onClick={() => {
                            save.reset()
                            setFixing(fact)
                            setDraft(fact.text)
                          }}
                        >
                          Corregir
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-11 sm:min-h-8"
                          aria-label={`Quitar: ${fact.text}`}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(fact.id)}
                        >
                          Quitar
                        </Button>
                      </span>
                    ) : null}
                  </li>
                ))}
                {memory.derived.map((item) => (
                  <li key={item.text} className="rounded-xl border bg-muted/50 p-3 text-sm">
                    <span className="font-semibold">{item.text}</span>
                    <span className="block text-muted-foreground">{item.origin} · se cambia en la ficha</span>
                  </li>
                ))}
              </ul>
            )}
            {remove.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationErrorMessage(remove.error)}
              </p>
            ) : null}
          </DetailSection>

          {canWrite ? (
            <form onSubmit={submit} className="flex flex-col gap-2">
              <Field>
                <FieldLabel htmlFor="memoria-dato">{fixing ? "Corregir el dato" : "Agregar un dato"}</FieldLabel>
                <Input
                  id="memoria-dato"
                  value={draft}
                  maxLength={200}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Prefiere citas por la tarde"
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
                <SubmitButton type="submit" pending={save.isPending} disabled={draft.trim().length < 3} className="min-h-11 sm:min-h-9">
                  {fixing ? "Guardar la corrección" : "Agregar"}
                </SubmitButton>
                {fixing ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    onClick={() => {
                      setFixing(null)
                      setDraft("")
                    }}
                  >
                    Dejarlo como estaba
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}

          <p className="rounded-xl bg-muted/60 p-3 text-sm">
            <span className="font-semibold">Nunca guarda</span> síntomas, diagnósticos ni nada de la historia clínica. Cada dato lleva fecha y
            origen.
          </p>
        </div>
      )}
    </DetailDrawer>
  )
}
