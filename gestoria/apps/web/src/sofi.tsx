import { Badge, Button, cn, FieldGroup, toast } from "@odentia/ui"
import {
  AgentMark,
  ErrorState,
  PageNotice,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MessageSquarePlus, SendHorizontal } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { ToggleField } from "./campos"
import { api } from "./lib/api"
import { STATE_TONE, stateName } from "./lib/pedidos"
import { AGENT_STOP_WORDS } from "./lib/plan"
import type {
  AgentSettings,
  AnswerStatus,
  ConversationMessage,
  ConversationView,
  SofiOverview,
} from "./lib/sofi"
import { usd } from "./lib/sofi"
import { money } from "./lib/tienda"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Sofi» (lienzo B, tablero 8): lo que el dueño le deja escrito y «Probar a Sofi». Mientras no
 * hay WhatsApp (B2), la prueba es la única forma de verla vender: quien prueba escribe como
 * cliente y Sofi responde con el catálogo, los precios y los límites de verdad. Sus pedidos son
 * de prueba: no mueven stock, no crean un link real y no cuentan en Reportes.
 */

const SOFI_KEY = (storeId: string) => ["sofi", storeId]

const messageSchema = z.object({
  text: z.string().trim().min(1, "Escribe el mensaje, como cliente."),
})

export function SofiPage() {
  const { store } = useStoreContext()
  const overview = useQuery({
    queryKey: SOFI_KEY(store.id),
    queryFn: () => api<SofiOverview>(`/api/tiendas/${store.id}/sofi`),
  })
  return (
    <>
      <StoreHeader
        title="Sofi"
        subtitle="La vendedora de tu tienda: responde, recomienda, negocia dentro de tus límites y cobra."
      />
      {overview.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      {overview.isError ? (
        <ErrorState
          error={overview.error instanceof Error ? overview.error : "No se pudo cargar"}
          onRetry={() => void overview.refetch()}
        />
      ) : null}
      {overview.data ? (
        <>
          {overview.data.agentStop ? (
            <PageNotice
              tone="limite"
              label="En pausa"
              action={
                store.permissions.includes("plan") ? (
                  <Link
                    to="/tiendas/$id/configuracion/plan"
                    params={{ id: store.id }}
                    className="underline"
                  >
                    Ver tu plan
                  </Link>
                ) : undefined
              }
            >
              {AGENT_STOP_WORDS[overview.data.agentStop]} La prueba de aquí sigue funcionando.
            </PageNotice>
          ) : null}
          <PageNotice tone="aviso" label="Sin WhatsApp">
            Sofi responderá a tus clientes cuando conectes tu número. Mientras, pruébala aquí:
            escribe como si fueras un cliente.
          </PageNotice>
          <TestChat overview={overview.data} />
          <Settings
            key={JSON.stringify(overview.data.settings)}
            settings={overview.data.settings}
          />
        </>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------- lo que pone el dueño */

type SwitchName = "enabled" | "followPayment" | "followThanks" | "followRestock" | "followReturn"

function Settings({ settings }: { settings: AgentSettings }) {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (body: AgentSettings & { displayName: string }) =>
      api(`/api/tiendas/${store.id}/sofi`, { method: "PATCH", body }),
  })
  const form = useAppForm({
    defaultValues: { ...settings, displayName: settings.displayName ?? "" },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      await queryClient.invalidateQueries({ queryKey: SOFI_KEY(store.id) })
      toast.success("Guardado")
    },
  })
  const { onSubmit, isSubmitting, error } = useFormSurface(form)
  const switchField = (name: SwitchName, label: (on: boolean) => string) => (
    <form.AppField name={name}>
      {() => <ToggleField label={label} disabled={!canEdit} />}
    </form.AppField>
  )
  return (
    <section
      aria-labelledby="sofi-ajustes"
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="sofi-ajustes" className="text-lg font-bold">
          Cómo vende
        </h2>
        <p className="text-sm text-muted-foreground">
          Sofi usa tu catálogo, tus precios mínimos y tus formas de pago y de entrega. Aquí va lo
          demás.{canEdit ? "" : " Lo cambia el dueño o un administrador."}
        </p>
      </div>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <fieldset disabled={!canEdit} className="contents">
          <FieldGroup>
            {switchField("enabled", (on) =>
              on
                ? "Encendida: atenderá tus conversaciones"
                : "Apagada: tus conversaciones esperan a una persona",
            )}
            <form.AppField name="displayName">
              {(field) => (
                <field.TextField
                  label="Cómo se presenta"
                  placeholder={`Sofi, de ${store.name}`}
                  maxLength={60}
                />
              )}
            </form.AppField>
            <form.AppField name="knowledge">
              {(field) => (
                <field.TextareaField
                  label="Lo que debe saber"
                  maxLength={2000}
                  rows={4}
                  placeholder="Horario, cambios de talla, cómo se cuida el producto…"
                  description="Lo cuenta tal cual. Lo que no esté aquí ni en tu catálogo no lo inventa: lo pasa a una persona."
                />
              )}
            </form.AppField>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-medium">
                Seguimientos que Argos le encarga
              </legend>
              {switchField("followPayment", () => "Recordar el pago a quien no pagó")}
              {switchField(
                "followThanks",
                () => "Agradecer y preguntar si llegó bien, al día siguiente",
              )}
              {switchField("followRestock", () => "Avisar que volvió lo que alguien pidió agotado")}
              {switchField("followReturn", () => "Invitar a volver a quien compró hace dos meses")}
            </fieldset>
          </FieldGroup>
        </fieldset>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton type="submit" pending={isSubmitting}>
              Guardar
            </SubmitButton>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  )
}

/* ------------------------------------------------------------------- probar a Sofi */

function TestChat({ overview }: { overview: SofiOverview }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useState<string | null>(overview.tests[0]?.id ?? null)
  const conversation = useQuery({
    queryKey: ["conversacion", store.id, conversationId],
    enabled: Boolean(conversationId),
    queryFn: async () =>
      (
        await api<{ conversation: ConversationView }>(
          `/api/tiendas/${store.id}/conversaciones/${conversationId}`,
        )
      ).conversation,
  })
  const start = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/tiendas/${store.id}/sofi/pruebas`, { method: "POST" }),
    onSuccess: async ({ id }) => {
      setConversationId(id)
      await queryClient.invalidateQueries({ queryKey: SOFI_KEY(store.id) })
    },
  })
  const [pendingText, setPendingText] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: async (message: string) => {
      const id = conversationId ?? (await start.mutateAsync()).id
      return api<{ conversation: ConversationView; result: { status: AnswerStatus } }>(
        `/api/tiendas/${store.id}/conversaciones/${id}/cliente`,
        { method: "POST", body: { text: message } },
      )
    },
    onMutate: (message) => setPendingText(message),
    onSuccess: (data) => {
      queryClient.setQueryData(["conversacion", store.id, data.conversation.id], data.conversation)
      if (data.result.status === "sin_modelo")
        toast.error("Sofi no pudo responder: falta configurar su modelo.")
    },
    onSettled: () => setPendingText(null),
  })
  const giveBack = useMutation({
    mutationFn: () =>
      api<{ conversation: ConversationView }>(
        `/api/tiendas/${store.id}/conversaciones/${conversationId}/devolver`,
        { method: "POST" },
      ),
    onSuccess: (data) =>
      queryClient.setQueryData(["conversacion", store.id, data.conversation.id], data.conversation),
  })
  const view = conversation.data
  const end = useRef<HTMLDivElement>(null)
  const count = (view?.messages.length ?? 0) + (pendingText ? 1 : 0)
  useEffect(() => {
    if (count > 0) end.current?.scrollIntoView({ block: "nearest" })
  }, [count])
  const disabled = !overview.modelReady || send.isPending || view?.handler === "persona"
  const form = useAppForm({
    defaultValues: { text: "" },
    validators: { onSubmit: messageSchema },
    onSubmit: async ({ value, formApi }) => {
      if (disabled) return
      await send.mutateAsync(value.text.trim())
      formApi.reset()
    },
  })
  const { onSubmit, error: sendError } = useFormSurface(form)
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }
  const otherError = start.error ?? giveBack.error
  const shownError = sendError ?? (otherError ? submitErrorMessage(otherError) : null)

  return (
    <section
      aria-labelledby="sofi-prueba"
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="sofi-prueba" className="text-lg font-bold">
            Probar a Sofi
          </h2>
          <p className="text-sm text-muted-foreground">
            Sus pedidos son de prueba: no mueven el stock, no crean un link de pago real y no
            cuentan en Reportes.
          </p>
        </div>
        {view && view.messages.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => start.mutate()}
            disabled={start.isPending}
          >
            <MessageSquarePlus aria-hidden />
            Empezar otra prueba
          </Button>
        ) : null}
      </div>
      {!overview.modelReady ? (
        <PageNotice tone="limite" label="Sin modelo">
          Sofi todavía no puede responder: falta configurar su modelo en el servidor.
        </PageNotice>
      ) : null}
      {conversation.isError ? (
        <ErrorState
          error={conversation.error instanceof Error ? conversation.error : "No se pudo cargar"}
          onRetry={() => void conversation.refetch()}
        />
      ) : null}
      <div
        className="flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border bg-surface-muted p-3"
        role="log"
        aria-live="polite"
        aria-label="La conversación de prueba"
      >
        {!view || view.messages.length === 0 ? (
          <p className="m-auto max-w-xs text-center text-sm text-muted-foreground">
            Escribe como un cliente: «Hola, ¿tienen la zapatilla blanca en 38?»
          </p>
        ) : (
          view.messages.map((message) => <Bubble key={message.id} message={message} />)
        )}
        {pendingText ? (
          <>
            <Bubble
              message={{
                id: "pendiente",
                author: "cliente",
                text: pendingText,
                createdAt: new Date().toISOString(),
                delivery: null,
                needsTemplate: false,
                followUp: null,
                byArgos: false,
              }}
            />
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <AgentMark size="sm" />
              Sofi está escribiendo…
            </p>
          </>
        ) : null}
        <div ref={end} />
      </div>
      {view && view.orders.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Pedidos de esta conversación">
          {view.orders.map((order) => (
            <li key={order.id}>
              <Link
                to="/tiendas/$id/pedidos"
                params={{ id: store.id }}
                search={{ pedido: order.id }}
                className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <span className="font-mono">Pedido {order.number}</span>
                <Badge variant={STATE_TONE[order.state]}>{stateName(order)}</Badge>
                <span className="tabular-nums">{money(order.totalCents, store.currency)}</span>
                {order.test ? <Badge variant="outline">Prueba</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {view?.handler === "persona" ? (
        <PageNotice
          tone="alarma"
          label="Espera a una persona"
          action={
            <Button size="sm" variant="outline" onClick={() => giveBack.mutate()}>
              Devolver a Sofi
            </Button>
          }
        >
          Sofi pasó esta conversación a una persona: {view.waitingReason ?? "sin motivo"}.
        </PageNotice>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="flex items-end gap-2">
        <form.AppField name="text">
          {(field) => (
            <field.TextareaField
              label="Tu mensaje, como cliente"
              hideLabel
              className="min-w-0 flex-1"
              onKeyDown={onKey}
              rows={2}
              maxLength={1000}
              placeholder="Escribe como cliente…"
              disabled={!overview.modelReady || view?.handler === "persona"}
            />
          )}
        </form.AppField>
        <Button type="submit" disabled={disabled} aria-label="Enviar">
          <SendHorizontal aria-hidden />
          <span className="hidden sm:inline">Enviar</span>
        </Button>
      </form>
      {shownError ? (
        <p role="alert" className="text-sm text-danger">
          {shownError}
        </p>
      ) : null}
      {view && view.costMicros > 0 ? (
        <p className="text-xs text-muted-foreground">Esta prueba costó {usd(view.costMicros)}.</p>
      ) : null}
    </section>
  )
}

function Bubble({ message }: { message: ConversationMessage }) {
  const mine = message.author === "cliente"
  return (
    <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {message.author === "sofi" ? (
          <>
            <AgentMark size="sm" />
            Sofi · Agente{message.byArgos ? " · encargo de Argos" : ""}
          </>
        ) : message.author === "persona" ? (
          "Una persona del equipo"
        ) : (
          "Tú, como cliente"
        )}
      </span>
      <p
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
          mine ? "bg-primary text-primary-foreground" : "border bg-card",
        )}
      >
        {message.text}
      </p>
      {message.basis && (message.basis.tools.length > 0 || message.basis.stopped.length > 0) ? (
        <p className="max-w-[85%] text-xs text-muted-foreground">
          {message.basis.tools.join(" · ")}
          {message.basis.stopped.length > 0
            ? `${message.basis.tools.length ? " · " : ""}La comprobación frenó una respuesta y la corrigió`
            : ""}
        </p>
      ) : null}
    </div>
  )
}
