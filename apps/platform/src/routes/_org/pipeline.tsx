import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core"
import { Badge, Button, Field, FieldLabel, Input } from "@odentia/ui"
import { EmptyState, FormDrawer, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"
import { apiFetch } from "../../lib/api"
import {
  type ContactListItem,
  type OpportunityListItem,
  type Pipeline,
  timeAgo,
  useMyUserId,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/pipeline")({
  component: PipelinePage,
})

function PipelinePage() {
  const queryClient = useQueryClient()
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const canWrite = usePermission("crm.write")
  const [q, setQ] = useState("")
  const [onlyMine, setOnlyMine] = useState(false)
  const [onlyDue, setOnlyDue] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })

  const pipeline =
    pipelinesQuery.data?.data.find((p) => p.isDefault) ?? pipelinesQuery.data?.data[0]
  const stages = pipeline?.stages ?? []

  const cardsQuery = useQuery({
    queryKey: [
      "pipeline-cards",
      pipeline?.id,
      stages.map((s) => s.id).join(","),
      q,
      onlyMine,
      onlyDue,
    ],
    queryFn: async () => {
      const entries = await Promise.all(
        stages.map(async (stage) => {
          const params = new URLSearchParams({ stageId: stage.id, limit: "100" })
          if (q.trim()) params.set("q", q.trim())
          if (onlyMine) params.set("assignedUserId", myUserId)
          if (onlyDue) params.set("nextActionDue", "true")
          const res = await apiFetch<{ data: OpportunityListItem[] }>(
            `/api/opportunities?${params.toString()}`,
          )
          return [stage.id, res.data] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, OpportunityListItem[]>
    },
    enabled: !!pipeline,
  })

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
  })

  const moveMutation = useMutation({
    mutationFn: ({ opportunityId, stageId }: { opportunityId: string; stageId: string }) =>
      apiFetch(`/api/opportunities/${opportunityId}/move`, {
        method: "POST",
        body: JSON.stringify({ stageId }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
    },
  })

  function handleDragEnd(event: DragEndEvent) {
    const opportunityId = event.active.id as string
    const over = event.over?.id as string | undefined
    if (!over || over === opportunityId) return
    const cards = cardsQuery.data ?? {}
    let targetStage = stages.some((s) => s.id === over) ? over : null
    if (!targetStage) {
      for (const [stageId, list] of Object.entries(cards)) {
        if (list.some((o) => o.id === over)) {
          targetStage = stageId
          break
        }
      }
    }
    if (!targetStage) return
    const current = Object.entries(cards).find(([, list]) =>
      list.some((o) => o.id === opportunityId),
    )
    if (current?.[0] === targetStage) return
    moveMutation.mutate({ opportunityId, stageId: targetStage })
  }

  if (!pipeline && !pipelinesQuery.isLoading) {
    return (
      <PageShell>
        <EmptyState title="Sin pipeline" description="No hay pipeline configurado." />
      </PageShell>
    )
  }

  return (
    <PageShell className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Pipeline"
        subtitle={pipeline ? `Tablero · ${pipeline.name}` : "Tablero"}
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Nueva oportunidad
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por título o interés…"
          className="max-w-xs"
        />
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={(e) => setOnlyMine(e.target.checked)}
          />
          Solo asignadas a mí
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} />
          Seguimiento pendiente
        </label>
      </div>
      <DndContext onDragEnd={handleDragEnd}>
        <div
          className="grid min-h-0 flex-1 gap-3"
          style={{ gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(0, 1fr))` }}
        >
          {stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stageId={stage.id}
              name={stage.name}
              kind={stage.kind}
              cards={cardsQuery.data?.[stage.id] ?? []}
            />
          ))}
        </div>
      </DndContext>
      {createOpen && pipeline && (
        <CreateOpportunityDialog
          pipelineId={pipeline.id}
          stages={stages}
          members={members}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
          }}
        />
      )}
    </PageShell>
  )
}

function StageColumn({
  stageId,
  name,
  kind,
  cards,
}: {
  stageId: string
  name: string
  kind: string
  cards: OpportunityListItem[]
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stageId })
  return (
    <section
      ref={setNodeRef}
      className={`flex min-w-0 flex-col gap-2 rounded-lg border p-2 ${isOver ? "border-primary" : ""}`}
    >
      <header className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <span
            className={`size-2 rounded-full ${
              kind === "won" ? "bg-green-500" : kind === "lost" ? "bg-red-400" : "bg-sky-500"
            }`}
          />
          {name}
        </span>
        <Badge variant="secondary">{cards.length}</Badge>
      </header>
      {cards.map((card) => (
        <DraggableCard key={card.id} card={card} />
      ))}
    </section>
  )
}

export function formatMoney(amountCents: number | null, currency: string): string | null {
  if (amountCents === null) return null
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(amountCents / 100)
  } catch {
    return `${amountCents / 100} ${currency}`
  }
}

function DraggableCard({ card }: { card: OpportunityListItem }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id })
  const money = formatMoney(card.amountCents, card.currency)
  const overdue = card.nextActionAt !== null && new Date(card.nextActionAt).getTime() < Date.now()
  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`flex flex-col gap-1 rounded-md border bg-card p-2.5 text-sm shadow-sm ${isDragging ? "opacity-50" : ""}`}
    >
      <Link
        to="/opportunities/$opportunityId"
        params={{ opportunityId: card.id }}
        className="font-medium hover:underline"
      >
        {card.title}
      </Link>
      <span className="text-xs text-muted-foreground">{card.contactName}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {card.patientName && <Badge variant="outline">{card.patientName}</Badge>}
        {card.interestText && <span>{card.interestText}</span>}
        {money && <span className="font-medium text-foreground">{money}</span>}
      </span>
      {card.nextActionAt && (
        <span className={`text-xs ${overdue ? "font-medium text-red-600" : "text-muted-foreground"}`}>
          {overdue ? "Seguimiento vencido · " : "Próxima acción · "}
          {timeAgo(card.nextActionAt)}
        </span>
      )}
    </article>
  )
}

function CreateOpportunityDialog({
  pipelineId,
  stages,
  members,
  onClose,
  onCreated,
}: {
  pipelineId: string
  stages: Pipeline["stages"]
  members: Array<{ userId: string; role: string; user: { name: string } }>
  onClose: () => void
  onCreated: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const contactsQuery = useQuery({
    queryKey: ["contacts-for-opportunity"],
    queryFn: () => apiFetch<{ data: ContactListItem[] }>("/api/contacts?limit=100"),
  })
  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/opportunities", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: onCreated,
    onError: (e: Error) => setError(e.message),
  })

  function handleSubmit(form: FormData) {
    setError(null)
    const amount = String(form.get("amount") ?? "").trim()
    createMutation.mutate({
      contactId: String(form.get("contactId")),
      title: String(form.get("title")),
      stageId: String(form.get("stageId")) || undefined,
      pipelineId,
      interestText: String(form.get("interestText") ?? "").trim() || null,
      amountCents: amount ? Math.round(Number(amount) * 100) : null,
      currency: String(form.get("currency") ?? "PEN").trim().toUpperCase() || "PEN",
      assignedUserId: String(form.get("assignedUserId") ?? "") || null,
      nextActionAt: String(form.get("nextActionAt") ?? "") || null,
      nextActionNote: String(form.get("nextActionNote") ?? "").trim() || null,
    })
  }

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault()
    handleSubmit(new FormData(event.currentTarget as HTMLFormElement))
  }

  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Nueva oportunidad"
      onSubmit={handleFormSubmit}
      isSubmitting={createMutation.isPending}
      error={error}
      submitLabel="Crear"
      cancelLabel="Cancelar"
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="opp-contact">Contacto</FieldLabel>
          <select id="opp-contact" name="contactId" required className="rounded-md border bg-background px-2 py-1.5 text-sm" defaultValue="">
            <option value="" disabled>
              Elegir contacto…
            </option>
            {(contactsQuery.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="opp-title">Título</FieldLabel>
          <Input id="opp-title" name="title" required maxLength={200} placeholder="Ortodoncia · evaluación" />
        </Field>
        <Field>
          <FieldLabel htmlFor="opp-stage">Etapa</FieldLabel>
          <select id="opp-stage" name="stageId" className="rounded-md border bg-background px-2 py-1.5 text-sm" defaultValue={stages[0]?.id ?? ""}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="opp-interest">Interés / servicio</FieldLabel>
          <Input id="opp-interest" name="interestText" maxLength={500} placeholder="Ortodoncia, profilaxis…" />
        </Field>
        <div className="flex gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor="opp-amount">Valor</FieldLabel>
            <Input id="opp-amount" name="amount" type="number" min="0" step="0.01" placeholder="2500.00" />
          </Field>
          <Field className="w-24">
            <FieldLabel htmlFor="opp-currency">Moneda</FieldLabel>
            <Input id="opp-currency" name="currency" maxLength={3} defaultValue="PEN" />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="opp-assignee">Asignado</FieldLabel>
          <select id="opp-assignee" name="assignedUserId" className="rounded-md border bg-background px-2 py-1.5 text-sm" defaultValue="">
            <option value="">Sin asignar</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="opp-next-action">Próxima acción (fecha y hora)</FieldLabel>
          <Input id="opp-next-action" name="nextActionAt" type="datetime-local" />
        </Field>
        <Field>
          <FieldLabel htmlFor="opp-note">Nota de seguimiento</FieldLabel>
          <Input id="opp-note" name="nextActionNote" maxLength={500} placeholder="Llamar para confirmar…" />
        </Field>
      </div>
    </FormDrawer>
  )
}
