import { Badge, Button } from "@odentia/ui"
import { ConfirmDialog, FormDrawer, LoadingState, submitErrorMessage, useAppForm, useFormSurface, ViewTabs } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { GUIDANCE_KEY, type GuidanceItem, type GuidanceList } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"
import { QueryErrorState } from "../../lib/query-error"
import { appWords } from "../../lib/product-words"
import { WithdrawLessonDialog } from "./lesson-drawer"

/**
 * Lo que mide una regla (`RULE_BODY_CHARS` de los servicios, ADR 0119): va
 * entera en cada mensaje. Una anterior más larga se edita aquí hasta acortarla.
 */
const GUIDANCE_CHARS = 300

/** Lo que admite `POST|PATCH /api/agent/learning/guidance`, con sus mismas palabras. */
const guidanceSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Escribe qué debe saber el agente")
    .max(GUIDANCE_CHARS, `Como mucho ${GUIDANCE_CHARS} caracteres`),
})

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
 * su origen. Todas se editan y se retiran igual; las aprendidas llevan «Ver
 * conversación». Lo que llega al agente es esta misma lista. Lo retirado queda
 * al pie y se puede restaurar.
 */
export function AgentGuidance({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  // Está en la página de recepción: es lo que le llega a ella.
  const receptionName = useReceptionName()
  const [filter, setFilter] = useState<Filter>("todas")
  const [editing, setEditing] = useState<GuidanceItem | "nueva" | null>(null)
  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  const [showWithdrawn, setShowWithdrawn] = useState(false)
  const query = useQuery({
    queryKey: [...GUIDANCE_KEY, filter],
    queryFn: () =>
      apiFetch<{ data: GuidanceList }>(`/api/agent/learning/guidance${filter === "todas" ? "" : `?source=${filter}`}`),
  })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: GUIDANCE_KEY })
    void queryClient.invalidateQueries({ queryKey: ["agent-learning"] })
  }
  const restore = useMutation({
    retry: false,
    mutationFn: (item: GuidanceItem) => apiFetch(`/api/agent/learning/lessons/${item.id}/restore`, { method: "POST" }),
    onSuccess: refresh,
  })
  const data = query.data?.data
  // Todas llegan en cada mensaje: hay un tope (ADR 0119) y se dice cuánto falta.
  const full = data ? data.counts.all >= data.limits.rules : false
  const options: Array<{ value: Filter; label: string; count: number | undefined }> = [
    { value: "todas", label: "Todas", count: data?.counts.all },
    { value: "escrita", label: "Escritas por la clínica", count: data?.counts.escrita },
    { value: "aprendida", label: "Aprendidas", count: data?.counts.aprendida },
  ]
  const withdrawn = data?.withdrawn ?? []

  return (
    <section aria-labelledby="lo-que-debe-saber" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id="lo-que-debe-saber" className="font-heading text-base font-semibold">
            Lo que {receptionName} debe saber
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo que le pide la clínica y las reglas que aprendió de sus correcciones. Le llega todo en cada mensaje. Los datos concretos (precios,
            horarios) van en Conocimiento.
          </p>
          {data ? (
            <p className={`text-sm ${full ? "font-semibold text-warning" : "text-muted-foreground"}`}>
              {data.counts.all} de {data.limits.rules} reglas
              {full ? ": para agregar otra, retira o une una." : "."}
            </p>
          ) : null}
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
              ? "Todavía no aprendió reglas de tus correcciones. Aparecen cuando corriges con «No debió responder» y lo apruebas."
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
                {data.limits.chars < item.body.length ? (
                  <p className="text-sm font-semibold text-warning">
                    Le llega cortada: pasa de {data.limits.chars} caracteres. Edítala más corta o llévala a Conocimiento.
                  </p>
                ) : null}
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
                    Ver la conversación
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
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-label={`Retirar: ${item.body.slice(0, 60)}`}
                      onClick={() => setWithdrawing(item.id)}
                    >
                      Retirar
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {withdrawn.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="link"
            className="h-auto min-h-11 self-start p-0 text-muted-foreground sm:min-h-8"
            aria-expanded={showWithdrawn}
            aria-controls="saber-retiradas"
            onClick={() => setShowWithdrawn((value) => !value)}
          >
            Retiradas · {withdrawn.length}, se pueden restaurar
          </Button>
          {showWithdrawn ? (
            <ul id="saber-retiradas" aria-label="Retiradas" className="flex flex-col divide-y rounded-xl border">
              {withdrawn.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <p className="min-w-0 flex-1 basis-56 break-words text-muted-foreground">{item.body}</p>
                  {canWrite ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-label={`Restaurar: ${item.body.slice(0, 60)}`}
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(item)}
                    >
                      Restaurar
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {restore.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(restore.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      <GuidanceDrawer target={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <WithdrawLessonDialog lessonId={withdrawing} onClose={() => setWithdrawing(null)} />
    </section>
  )
}

/** Lo que dice `POST /api/agent/learning/guidance/check`: la regla activa con la que choca, si hay una. */
interface TextCheck {
  conflictWith: { id: string; body: string } | null
}

/**
 * Agregar o editar una línea: una idea por línea. Si contradice otra regla, lo
 * dice antes de guardar y deja decidir. Avisa y no impide guardar; si no se pudo
 * comprobar, guarda igual.
 */
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
  const [conflict, setConflict] = useState<{ id: string; body: string } | null>(null)
  /** El texto que espera la decisión del aviso. */
  const pendingBody = useRef("")
  const save = useMutation({
    retry: false,
    mutationFn: ({ body, replaceId }: { body: string; replaceId?: string }) =>
      target && target !== "nueva"
        ? apiFetch(`/api/agent/learning/guidance/${target.id}`, { method: "PATCH", body: JSON.stringify({ body, replaceId }) })
        : apiFetch("/api/agent/learning/guidance", { method: "POST", body: JSON.stringify({ body, replaceId }) }),
    onSuccess: () => {
      setConflict(null)
      onSaved()
      onClose()
    },
  })
  const form = useAppForm({
    defaultValues: { body: saved },
    validators: { onSubmit: guidanceSchema },
    onSubmit: async ({ value }) => {
      const body = value.body.trim()
      if (body !== saved) {
        const check = await apiFetch<{ data: TextCheck }>("/api/agent/learning/guidance/check", {
          method: "POST",
          body: JSON.stringify({ body, ...(target && target !== "nueva" ? { id: target.id } : {}) }),
        }).catch(() => null)
        if (check?.data.conflictWith) {
          pendingBody.current = body
          setConflict(check.data.conflictWith)
          return
        }
      }
      await save.mutateAsync({ body })
    },
  })
  // Al abrir otra línea (o «Agregar»), el borrador empieza con su texto.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al cambiar de línea, para no pisar lo que se está escribiendo.
  useEffect(() => {
    form.reset({ body: saved })
    setConflict(null)
  }, [target])
  const surface = useFormSurface(form)
  return (
    <>
      <FormDrawer
        {...surface}
        open={target !== null}
        onClose={onClose}
        title={target === "nueva" ? "Agregar a lo que debe saber" : "Editar"}
        description="Cómo quieres que atienda. Los datos concretos (precios, horarios, políticas) van en Conocimiento."
        submitLabel="Guardar"
        cancelLabel="Cancelar"
      >
        <form.AppField name="body">
          {(field) => (
            <field.TextareaField
              id="lo-que-debe-saber-texto"
              label="Qué debe saber"
              rows={4}
              maxLength={GUIDANCE_CHARS}
              placeholder="Si alguien llega con dolor, ofrece la primera cita disponible del día."
              description={
                <>
                  Una idea corta, hasta {GUIDANCE_CHARS} caracteres. No puede contradecir lo que fija {appWords().name}: ante un choque, gana la
                  base.
                </>
              }
            />
          )}
        </form.AppField>
      </FormDrawer>
      <ConfirmDialog
        open={conflict !== null}
        title="Contradice otra regla"
        description={conflict ? `Esto contradice «${conflict.body}». ¿Cuál vale?` : ""}
        confirmLabel="Reemplazar"
        cancelLabel="Seguir editando"
        variant="default"
        pending={save.isPending}
        error={conflict && save.isError ? submitErrorMessage(save.error) : null}
        onClose={() => {
          if (!save.isPending) {
            save.reset()
            setConflict(null)
          }
        }}
        onConfirm={() => conflict && save.mutate({ body: pendingBody.current, replaceId: conflict.id })}
      >
        <p className="text-sm text-muted-foreground">«Reemplazar» deja solo la nueva, y la otra queda en Retiradas. Si mantienes las dos, le llegan las dos.</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start sm:min-h-9"
          disabled={save.isPending}
          onClick={() => save.mutate({ body: pendingBody.current })}
        >
          Mantener las dos
        </Button>
      </ConfirmDialog>
    </>
  )
}
