import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { Chip, EmptyState, PageHeader } from "@odentia/ui-patterns";
import { MessageCircle, Send } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { timeAgo, type ContactListItem, type Pipeline } from "../../lib/crm";
import { useOrgEvents } from "../../lib/org-events";

export const Route = createFileRoute("/_org/pipeline")({
  component: PipelinePage,
});

function PipelinePage() {
  const queryClient = useQueryClient();

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  });

  const pipeline = pipelinesQuery.data?.data.find((p) => p.isDefault) ?? pipelinesQuery.data?.data[0];
  const stages = pipeline?.stages ?? [];

  const stageQueries = useQuery({
    queryKey: ["pipeline-cards", pipeline?.id, stages.map((s) => s.id).join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        stages.map(async (stage) => {
          const res = await apiFetch<{ data: ContactListItem[] }>(
            `/api/contacts?stageId=${stage.id}&limit=100`,
          );
          return [stage.id, res.data] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, ContactListItem[]>;
    },
    enabled: !!pipeline,
  });

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] });
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
  });

  const moveMutation = useMutation({
    mutationFn: ({ contactId, stageId }: { contactId: string; stageId: string }) =>
      apiFetch(`/api/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify({ stageId }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] });
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  function handleDragEnd(event: DragEndEvent) {
    const contactId = event.active.id as string;
    const over = event.over?.id as string | undefined;
    if (!over || over === contactId) return;
    // Soltar sobre columna (id etapa) o sobre otra tarjeta (id contacto con etapa).
    const cards = stageQueries.data ?? {};
    let targetStage = stages.some((s) => s.id === over) ? over : null;
    if (!targetStage) {
      for (const [stageId, list] of Object.entries(cards)) {
        if (list.some((c) => c.id === over)) {
          targetStage = stageId;
          break;
        }
      }
    }
    if (!targetStage) return;
    const current = Object.entries(cards).find(([, list]) => list.some((c) => c.id === contactId));
    if (current?.[0] === targetStage) return;
    moveMutation.mutate({ contactId, stageId: targetStage });
  }

  if (!pipeline && !pipelinesQuery.isLoading) {
    return <EmptyState title="Sin pipeline" description="No hay pipeline configurado." />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader title="Pipeline" subtitle={pipeline ? `Tablero · ${pipeline.name}` : "Tablero"} />
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
              cards={stageQueries.data?.[stage.id] ?? []}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
function StageColumn({ stageId, name, kind, cards }: { stageId: string; name: string; kind: string; cards: ContactListItem[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stageId });
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
        <Chip>{cards.length}</Chip>
      </header>
      {cards.map((card) => (
        <DraggableCard key={card.id} card={card} />
      ))}
    </section>
  );
}

function DraggableCard({ card }: { card: ContactListItem }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });
  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`flex flex-col gap-1 rounded-md border bg-card p-2.5 text-sm shadow-sm ${isDragging ? "opacity-50" : ""}`}
    >
      <Link to="/contacts/$contactId" params={{ contactId: card.id }} className="font-medium hover:underline">
        {card.displayName}
      </Link>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {card.channels.includes("whatsapp") && <MessageCircle className="size-3.5 text-green-600" />}
        {card.channels.includes("telegram") && <Send className="size-3.5 text-sky-600" />}
        {timeAgo(card.lastInteractionAt)}
      </span>
    </article>
  );
}
