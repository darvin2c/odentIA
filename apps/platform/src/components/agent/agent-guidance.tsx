import { Badge, Button, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { ConfirmDialog, FormDrawer, LoadingState, ViewTabs } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { type FormEvent, useState } from "react"
import { GUIDANCE_KEY, type GuidanceItem, type GuidanceList } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

type Filter = "todas" | "escrita" | "aprendida"

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"

function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short" })
}

/**
 * De dónde viene la línea, después de su etiqueta: «Ana Torres · 3 mar» si la
 * escribió la clínica; «de la conversación con Rosa Díaz · aprobó Carmen · 12 mar»
 * si se aprendió.
 */
function originDetail(item: GuidanceItem): string {
  if (item.source === "escrita") return [item.byName, dayOf(item.at)].filter(Boolean).join(" · ")
  const from = item.contactName ? `de la conversación con ${item.contactName}` : "de una corrección"
  return [from, item.byName ? `aprobó ${item.byName}` : null, dayOf(item.at)].filter(Boolean).join(" · ")
}

/**
 * «Lo que el agente debe saber» (decisión 24): una sola lista con lo que
 * escribió la clínica y las reglas que aprendió y alguien aprobó, cada una con
 * su origen. Todas se editan y se borran igual; las aprendidas llevan «Ver
 * conversación». Lo que llega al agente es esta misma lista.
 */
export function AgentGuidance({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  // Está en la página de recepción: es lo que le llega a ella.
  const receptionName = useReceptionName()
  const [filter, setFilter] = useState<Filter>("todas")
  const [editing, setEditing] = useState<GuidanceItem | "nueva" | null>(null)
  const [removing, setRemoving] = useState<GuidanceItem | null>(null)
  const query = useQuery({
    queryKey: [...GUIDANCE_KEY, filter],
    queryFn: () =>
      apiFetch<{ data: GuidanceList }>(`/api/agent/learning/guidance${filter === "todas" ? "" : `?source=${filter}`}`),
  })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: GUIDANCE_KEY })
    void queryClient.invalidateQueries({ queryKey: ["agent-learning"] })
  }
  const remove = useMutation({
    retry: false,
    mutationFn: (item: GuidanceItem) => apiFetch(`/api/agent/learning/guidance/${item.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null)
      refresh()
    },
  })
  const data = query.data?.data
  const options: Array<{ value: Filter; label: string; count: number | undefined }> = [
    { value: "todas", label: "Todas", count: data?.counts.all },
    { value: "escrita", label: "Escritas por la clínica", count: data?.counts.escrita },
    { value: "aprendida", label: "Aprendidas", count: data?.counts.aprendida },
  ]

  return (
    <section aria-labelledby="lo-que-debe-saber" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id="lo-que-debe-saber" className="font-heading text-base font-semibold">
            Lo que {receptionName} debe saber
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo que le pide la clínica y lo que aprendió de sus correcciones, en una sola lista. Los datos concretos (precios, horarios) van en
            Conocimiento.
          </p>
        </div>
        {canWrite ? (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setEditing("nueva")}>
            <Plus aria-hidden />
            Agregar
          </Button>
        ) : null}
      </div>
      <ViewTabs label="Filtrar por origen" value={filter} options={options} onValueChange={setFilter} />
      {query.isPending ? (
        <LoadingState message="Cargando lo que sabe…" />
      ) : query.isError || !data ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : data.items.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          <p>
            {filter === "aprendida"
              ? "Todavía no aprendió nada de tus correcciones. Cuando corrijas una respuesta y apruebes la regla, aparece aquí."
              : filter === "escrita"
                ? "La clínica todavía no le escribió nada. Con la base y lo que sabe ya puede atender."
                : "Todavía no hay nada aquí. Con la base y lo que sabe ya puede atender."}
          </p>
          {canWrite && filter !== "aprendida" ? (
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setEditing("nueva")}>
              <Plus aria-hidden />
              Agregar
            </Button>
          ) : filter === "aprendida" ? (
            <Link to="/agent/learn" className={LINK}>
              Ir a Aprender
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {data.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-words">{item.body}</p>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant={item.source === "escrita" ? "secondary" : "outline"}>
                    {item.source === "escrita" ? "Escrita por la clínica" : "Aprendida"}
                  </Badge>
                  <span>{originDetail(item)}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {item.conversationId ? (
                  <Link to="/inbox" search={{ conversation: item.conversationId }} className={LINK}>
                    Ver conversación
                  </Link>
                ) : null}
                {canWrite ? (
                  <>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto min-h-11 p-0 sm:min-h-8"
                      aria-label={`Editar: ${item.body.slice(0, 60)}`}
                      onClick={() => setEditing(item)}
                    >
                      Editar
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto min-h-11 p-0 text-destructive sm:min-h-8"
                      aria-label={`Borrar: ${item.body.slice(0, 60)}`}
                      onClick={() => setRemoving(item)}
                    >
                      Borrar
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <GuidanceDrawer target={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={removing !== null}
        title="Borrar de lo que debe saber"
        description={
          removing
            ? `«${removing.body.slice(0, 160)}» deja de llegarle a ${receptionName} desde ahora.${removing.source === "aprendida" ? " La regla queda retirada en Aprender y se puede restaurar." : ""}`
            : ""
        }
        confirmLabel="Borrar"
        variant="destructive"
        pending={remove.isPending}
        onClose={() => {
          if (!remove.isPending) {
            remove.reset()
            setRemoving(null)
          }
        }}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        {remove.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {mutationErrorMessage(remove.error) ?? "No pudimos borrarla."}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  )
}

/** Agregar o editar una línea: una idea por línea. */
function GuidanceDrawer({
  target,
  onClose,
  onSaved,
}: {
  target: GuidanceItem | "nueva" | null
  onClose: () => void
  onSaved: () => void
}) {
  const saved = target && target !== "nueva" ? target.body : ""
  const [text, setText] = useState(saved)
  const [openedFor, setOpenedFor] = useState<GuidanceItem | "nueva" | null>(null)
  if (target !== openedFor) {
    setOpenedFor(target)
    setText(saved)
  }
  const save = useMutation({
    retry: false,
    mutationFn: (body: string) =>
      target && target !== "nueva"
        ? apiFetch(`/api/agent/learning/guidance/${target.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
        : apiFetch("/api/agent/learning/guidance", { method: "POST", body: JSON.stringify({ body }) }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (save.isPending || !text.trim()) return
    save.mutate(text.trim())
  }
  return (
    <FormDrawer
      open={target !== null}
      onClose={() => {
        save.reset()
        onClose()
      }}
      title={target === "nueva" ? "Agregar a lo que debe saber" : "Editar"}
      description="Cómo quieres que atienda. Los datos concretos (precios, horarios, políticas) van en Conocimiento."
      onSubmit={submit}
      isSubmitting={save.isPending}
      isDirty={text !== saved}
      error={mutationErrorMessage(save.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      submitDisabled={!text.trim() || text === saved}
    >
      <Field>
        <FieldLabel htmlFor="lo-que-debe-saber-texto">Qué debe saber</FieldLabel>
        <Textarea
          id="lo-que-debe-saber-texto"
          rows={4}
          maxLength={600}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Si alguien llega con dolor, ofrece la primera cita disponible del día."
        />
        <FieldDescription>Una idea por línea. No puede contradecir lo que fija odentIA: ante un choque, gana la base.</FieldDescription>
      </Field>
    </FormDrawer>
  )
}
