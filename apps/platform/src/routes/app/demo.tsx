import { createFileRoute } from "@tanstack/react-router";
import { Field, Input } from "@odentia/ui";
import { Chip, EmptyState, PageHeader, SubmitButton } from "@odentia/ui-patterns";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { API_URL } from "../../lib/auth-client";

export const Route = createFileRoute("/app/demo")({
  component: DemoPage,
});

interface DemoEvent {
  kind: string;
  taskId: string | number;
  at: string;
}

function DemoPage() {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "open" | "closed">("connecting");
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/notifications/stream`, {
      withCredentials: true,
    });
    sourceRef.current = source;
    source.onopen = () => setStreamState("open");
    source.onerror = () => setStreamState("closed");
    source.addEventListener("demo_task.done", (event) => {
      const payload = JSON.parse((event as MessageEvent).data as string) as DemoEvent;
      setEvents((previous) => [payload, ...previous].slice(0, 50));
    });
    return () => source.close();
  }, []);

  async function sendTask() {
    if (!message.trim()) return;
    setSending(true);
    try {
      await apiFetch("/api/demo/tasks", {
        method: "POST",
        body: JSON.stringify({ message: message.trim() }),
      });
      setMessage("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Demo de tareas"
        subtitle="Cola durable (pgmq) + notificaciones en vivo (SSE)"
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendTask();
        }}
      >
        <Field>
          <div className="flex gap-3">
            <Input
              placeholder="Escribe un mensaje"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={200}
            />
            <SubmitButton type="submit" pending={sending} disabled={!message.trim()}>
              Enviar tarea
            </SubmitButton>
          </div>
        </Field>
      </form>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        Feed en vivo
        <Chip variant={streamState === "open" ? "success" : "neutral"}>
          {streamState === "open" ? "conectado" : streamState === "connecting" ? "conectando" : "desconectado"}
        </Chip>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="Sin eventos todavía"
          description="Envía una tarea y verás aquí el evento demo_task.done."
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="demo-feed">
          {events.map((event, index) => (
            <li
              key={`${event.taskId}-${index}`}
              className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
            >
              <span className="font-medium">{event.kind}</span>
              <span className="text-muted-foreground">
                tarea #{event.taskId} · {new Date(event.at).toLocaleTimeString("es-PE")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
