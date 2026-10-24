import { Button, cn } from "@odentia/ui"
import { ConfirmDialog, FormDrawer, RowActions } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../../lib/api"
import { type ConnectionItem, usePermission } from "../../../lib/crm"
import { sinceWords } from "../../../lib/integrations"
import { activeOrgTimeZone, useOrgLocale } from "../../../lib/locale"
import {
  accountWords,
  type ClinicMessage,
  type ConnectionSetup,
  type ConnectionTest,
  type ConnectionTone,
  type ConnectResult,
  connectionPending,
  connectionWords,
  ownMessageData,
  WHATSAPP_DISCONNECT_CONSEQUENCE,
  WHATSAPP_KEY_FIELDS,
  whatsappMessagesKey,
} from "../../../lib/whatsapp"
import { FacebookSignupButton, FacebookSignupPending } from "../../whatsapp/facebook-signup"
import { AccountField } from "./account-field"
import { ConnectedNotice } from "./connected-notice"
import { WhatsAppConnectSteps } from "./connect-steps"
import { WhatsAppMessagePanel } from "./message-panel"
import { WhatsAppMessages } from "./messages"
import { appWords } from "../../../lib/product-words"

const STATUS_WORD: Record<ConnectionTone, string> = {
  ok: "text-primary-soft-foreground",
  pending: "text-warning",
  off: "text-muted-foreground",
}

/** Cada cuánto se pregunta si Meta ya verificó la dirección o si ya llegó el primer mensaje. */
const SETUP_POLL_MS = 4000

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.shape.message ? error.shape.message : fallback
}

/** Lo que está abierto al lado: la clave o un mensaje (`id` nulo: uno nuevo). */
type Surface = { kind: "key" } | { kind: "message"; id: string | null; opening: number } | null

/**
 * «Cambiar la clave»: solo las dos claves, y basta con escribir la que cambió.
 * La conexión, su dirección y sus conversaciones siguen siendo las mismas.
 */
function KeyPanel({
  connectionId,
  onClose,
  onChanged,
}: {
  connectionId: string
  onClose: () => void
  onChanged: (result: ConnectResult) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [empty, setEmpty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDirty = Object.values(values).some((value) => value.trim() !== "")

  const change = useMutation({
    mutationFn: (config: Record<string, string>) =>
      apiFetch<{ data: ConnectResult }>(`/api/channels/connections/${connectionId}/credentials`, {
        method: "POST",
        body: JSON.stringify({ config }),
      }),
    onSuccess: ({ data }) => onChanged(data),
    onError: (failure) => setError(errorText(failure, "No pudimos cambiar la clave. Revísala y vuelve a intentarlo.")),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    // Solo viaja lo que se escribió: lo demás se conserva.
    const filled = Object.fromEntries(
      WHATSAPP_KEY_FIELDS.map((field) => [field.key, (values[field.key] ?? "").trim()] as const).filter(([, value]) => value !== ""),
    )
    if (Object.keys(filled).length === 0) {
      setEmpty(true)
      return
    }
    change.mutate(filled)
  }

  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Cambiar la clave de WhatsApp"
      description="La conexión, su dirección y sus conversaciones siguen siendo las mismas."
      onSubmit={submit}
      isDirty={isDirty}
      isSubmitting={change.isPending}
      error={error}
      submitLabel="Guardar la clave"
    >
      <div className="flex flex-col gap-4">
        {WHATSAPP_KEY_FIELDS.map((field) => (
          <AccountField
            key={field.key}
            id={`whatsapp-clave-${field.key}`}
            field={field}
            value={values[field.key] ?? ""}
            shown={Boolean(shown[field.key])}
            error={empty ? "Escribe al menos una de las claves." : null}
            extraHint="Déjala vacía si no cambió."
            onChange={(value) => {
              setValues((current) => ({ ...current, [field.key]: value }))
              setEmpty(false)
            }}
            onToggleShown={() => setShown((current) => ({ ...current, [field.key]: !current[field.key] }))}
          />
        ))}
        <p className="rounded-xl bg-muted px-3.5 py-3 text-sm text-muted-foreground">
          Con la clave nueva {appWords().name} comprueba que sea de la misma cuenta y vuelve a pedir a WhatsApp los mensajes que hayan
          faltado.
        </p>
      </div>
    </FormDrawer>
  )
}

/**
 * Un número de WhatsApp de la clínica: su tarjeta (con qué cuenta, cómo está y
 * qué se puede hacer), lo que falte para terminar de conectarlo —los pasos del
 * alta a mano o lo que quedó pendiente del botón de Facebook— y sus mensajes,
 * con el panel de cada uno al lado.
 */
export function WhatsAppConnection({
  connection,
  fresh,
  freshRead,
  freshByButton,
  showAccount,
  canWrite,
  fixedCreate,
  initialMessageId = null,
  onFreshRead,
}: {
  connection: ConnectionItem
  /** Lo que respondió el servidor al conectarla en esta visita; `null` si ya existía. */
  fresh: ConnectResult | null
  /** A mano: la persona ya leyó qué número se encontró y siguió al paso 2. */
  freshRead: boolean
  /** Se conectó con el botón de Facebook en esta visita. */
  freshByButton: boolean
  /** La clínica tiene más de un número: cada bloque dice de cuál es. */
  showAccount: boolean
  canWrite: boolean
  /** En teléfono «Nuevo mensaje» queda fijo al pie de la página. */
  fixedCreate: boolean
  /** El mensaje que se abre al llegar (`?mensaje=`), si es de esta conexión. */
  initialMessageId?: string | null
  onFreshRead: () => void
}) {
  const queryClient = useQueryClient()
  const locale = useOrgLocale()
  const canOpenAgent = usePermission("agent.read")
  const since = (iso: string) => sinceWords(iso, Date.now(), locale, activeOrgTimeZone())
  const active = connection.status === "active"
  const base = `/api/channels/connections/${connection.id}`
  // Con el botón de Facebook no hay dirección que copiar ni clave que cambiar.
  const byButton = Boolean(connection.signup)

  const [surface, setSurface] = useState<Surface>(null)
  const openings = useRef(0)
  const [confirming, setConfirming] = useState(false)
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [connectedDismissed, setConnectedDismissed] = useState(false)
  const messagesHeading = useRef<HTMLHeadingElement>(null)

  const refreshConnections = () => queryClient.invalidateQueries({ queryKey: ["connections"] })
  const refreshMessages = () => queryClient.invalidateQueries({ queryKey: whatsappMessagesKey(connection.id) })

  /* ---- Qué falta para terminar de conectar, según el servidor ---- */

  const pendingByList = connectionPending(connection)
  const manualPending = !byButton && pendingByList !== null
  const setupQuery = useQuery({
    queryKey: ["connection-setup", connection.id],
    queryFn: () => apiFetch<{ data: ConnectionSetup }>(`${base}/setup`),
    // La dirección y su clave son de quien administra la configuración.
    enabled: canWrite && active && !byButton && (manualPending || (fresh !== null && !freshRead)),
    retry: false,
    // La pantalla detecta sola cada paso: pregunta mientras falte alguno.
    refetchInterval: (query) => {
      if (query.state.status === "error") return false
      const data = query.state.data?.data
      return data && connectionPending(connection, data) === null ? false : SETUP_POLL_MS
    },
  })
  const pending = connectionPending(connection, byButton ? null : setupQuery.data?.data)
  const step = pending === "address" ? 2 : pending === "first-message" ? 3 : null
  const showingFound = !byButton && fresh !== null && !freshRead
  const showSteps = canWrite && active && !byButton && (showingFound || step !== null)

  // Cuando el servidor dice que al alta a mano ya no le falta nada, la lista de conexiones se entera.
  const settledOnce = useRef(false)
  useEffect(() => {
    if (pending !== null || !manualPending || settledOnce.current) return
    settledOnce.current = true
    void queryClient.invalidateQueries({ queryKey: ["connections"] })
  }, [pending, manualPending, queryClient])

  // Quien vio los pasos en esta visita, o volvió de la ventana de Meta, lee lo que quedó al terminar.
  const [sawSetup, setSawSetup] = useState(false)
  useEffect(() => {
    if (showSteps) setSawSetup(true)
  }, [showSteps])
  const showConnected = active && pending === null && !showingFound && (sawSetup || freshByButton) && !connectedDismissed

  /* ---- Mensajes ---- */

  const messagesQuery = useQuery({
    queryKey: whatsappMessagesKey(connection.id),
    queryFn: () => apiFetch<{ data: ClinicMessage[] }>(`${base}/messages`),
    enabled: active,
    retry: 1,
  })
  const items = messagesQuery.data?.data

  const sync = useMutation({
    mutationFn: () => apiFetch(`${base}/templates/sync`, { method: "POST" }),
    onSuccess: () => Promise.all([refreshMessages(), refreshConnections()]),
  })
  const syncError = sync.isError ? errorText(sync.error, "No pudimos actualizar los mensajes. Vuelve a intentarlo.") : null

  const openId = surface?.kind === "message" ? surface.id : null
  const openMessage = openId ? (items?.find((item) => item.id === openId) ?? null) : null
  // El mensaje abierto ya no existe (se eliminó aquí o en otra parte): el panel no tiene qué mostrar.
  const messageGone = openId !== null && items !== undefined && openMessage === null && !messagesQuery.isFetching
  useEffect(() => {
    if (messageGone) setSurface(null)
  }, [messageGone])

  function openMessagePanel(id: string | null) {
    openings.current += 1
    setSurface({ kind: "message", id, opening: openings.current })
  }

  // «Cambiar el texto» desde «Te espera»: el mensaje se abre una sola vez al llegar.
  const openedInitial = useRef(false)
  useEffect(() => {
    if (openedInitial.current || !initialMessageId || !items) return
    openedInitial.current = true
    if (items.some((item) => item.id === initialMessageId)) openMessagePanel(initialMessageId)
  }, [initialMessageId, items])

  /* ---- Acciones de la conexión ---- */

  const test = useMutation({
    mutationFn: () => apiFetch<{ data: ConnectionTest }>(`${base}/test`, { method: "POST" }),
    onSuccess: ({ data }) => {
      const account = accountWords(data.account)
      // Lo que dice el servidor: qué cuenta respondió o qué pasó y cómo arreglarlo.
      setTested(
        data.ok
          ? { ok: true, text: account ? `Funciona. Respondió ${account}.` : "Funciona. La cuenta respondió." }
          : { ok: false, text: data.problem?.trim() || "WhatsApp no respondió." },
      )
      void refreshConnections()
    },
    onError: (failure) => setTested({ ok: false, text: errorText(failure, "WhatsApp no respondió. Vuelve a intentarlo en un momento.") }),
  })

  const setStatus = useMutation({
    mutationFn: (next: "enable" | "disable") => apiFetch(`${base}/${next}`, { method: "POST" }),
    onSuccess: async (_result, next) => {
      await refreshConnections()
      setConfirming(false)
      setTested(null)
      setNotice({ ok: true, text: next === "disable" ? "WhatsApp quedó desconectado." : "WhatsApp volvió a conectarse." })
    },
  })
  const statusError = setStatus.isError ? errorText(setStatus.error, "No pudimos hacer el cambio. Vuelve a intentarlo.") : null

  function keyChanged(result: ConnectResult) {
    setSurface(null)
    setTested(null)
    const report = result.templates
    // Si la clave todavía no puede pedir mensajes, el servidor dice qué corregir.
    setNotice(
      report?.error
        ? { ok: false, text: `Clave cambiada. ${report.error}` }
        : {
            ok: true,
            text: `Clave cambiada. La conexión, su dirección y sus conversaciones siguen siendo las mismas.${
              report && report.requested > 0
                ? ` Se ${report.requested === 1 ? "pidió a WhatsApp 1 mensaje que faltaba" : `pidieron a WhatsApp ${report.requested} mensajes que faltaban`}.`
                : ""
            }`,
          },
    )
    void refreshConnections()
    void refreshMessages()
  }

  const words = connectionWords(connection, since, pending)
  const openKey = () => {
    setNotice(null)
    setSurface({ kind: "key" })
  }
  // En corto, lo que no es de todos los días va al menú.
  const menuItems = [
    ...(byButton ? [] : [{ key: "clave", label: "Cambiar la clave", onSelect: openKey }]),
    ...(active
      ? [{ key: "desconectar", label: "Desconectar", tone: "danger" as const, onSelect: () => setConfirming(true) }]
      : []),
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section
        aria-label={showAccount ? `Conexión de ${words.title}` : "Conexión"}
        className="@container elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
      >
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
          <span
            aria-hidden
            className={cn(
              "hidden size-11 shrink-0 items-center justify-center self-start rounded-xl text-sm font-bold @xl:flex",
              active ? "bg-primary-soft text-primary-soft-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            WA
          </span>
          <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
            <h2 className="font-heading text-base font-semibold [overflow-wrap:anywhere]">{words.title}</h2>
            <p className="text-sm">
              <strong className={cn("font-semibold", STATUS_WORD[words.tone])}>{words.status}</strong> {words.detail}
            </p>
            {words.facts.length > 0 ? (
              <ul className="mt-0.5 flex flex-wrap gap-1.5">
                {words.facts.map((fact) => (
                  <li key={fact} className="rounded-full bg-muted px-2.5 py-0.5 text-[13px]">
                    {fact}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {canWrite ? (
            <>
              {/* En ventana ancha, las acciones a la vista: si el panel lateral estrecha la tarjeta, bajan
                  de línea pero siguen siendo los mismos botones, y el foco vuelve a ellos al cerrarlo. */}
              <div className="hidden flex-wrap items-center gap-2 lg:flex">
                {active ? (
                  <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                    {test.isPending ? "Probando…" : "Probar conexión"}
                  </Button>
                ) : (
                  <Button type="button" disabled={setStatus.isPending} onClick={() => setStatus.mutate("enable")}>
                    {setStatus.isPending ? "Conectando…" : "Volver a conectar"}
                  </Button>
                )}
                {byButton ? null : (
                  <Button type="button" variant="outline" onClick={openKey}>
                    Cambiar la clave
                  </Button>
                )}
                {active ? (
                  <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirming(true)}>
                    Desconectar
                  </Button>
                ) : null}
              </div>
              {/* En teléfono: la acción de todos los días y, en el menú, las demás. */}
              <div className="flex w-full items-center gap-2 lg:hidden">
                {active ? (
                  <Button type="button" variant="outline" className="h-11 flex-1" disabled={test.isPending} onClick={() => test.mutate()}>
                    {test.isPending ? "Probando…" : "Probar"}
                    <span className="sr-only"> conexión</span>
                  </Button>
                ) : (
                  <Button type="button" className="h-11 flex-1" disabled={setStatus.isPending} onClick={() => setStatus.mutate("enable")}>
                    {setStatus.isPending ? "Conectando…" : "Volver a conectar"}
                  </Button>
                )}
                {menuItems.length > 0 ? <RowActions label="Más acciones de la conexión" items={menuItems} /> : null}
              </div>
            </>
          ) : null}
        </div>
        {tested ? (
          <p role="status" className={cn("text-sm font-medium", tested.ok ? "text-success" : "text-destructive")}>
            {tested.text}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className={cn("text-sm font-medium", notice.ok ? "text-success" : "text-warning")}>
            {notice.text}
          </p>
        ) : null}
        {statusError && !confirming ? (
          <p role="alert" className="text-sm text-destructive">
            {statusError}
          </p>
        ) : null}
        {/* Hecha con el botón: lo que haya quedado pendiente, con «Reintentar», y volver a conectar con él. */}
        {canWrite && byButton && active ? (
          <FacebookSignupPending
            connection={{ id: connection.id, signup: connection.signup ?? null }}
            onResolved={() => void refreshMessages()}
          />
        ) : null}
        {/* Quien solo consulta lee qué falta, con las palabras del servidor; reintentar es de quien administra. */}
        {!canWrite && pending === "signup" ? (
          <ul className="flex flex-col gap-1 rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-warning">
            {(connection.signup?.pending ?? []).map((item) => (
              <li key={item.step}>{item.title}</li>
            ))}
          </ul>
        ) : null}
        {canWrite && byButton ? (
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <p className="text-sm text-muted-foreground">
              Esta conexión se hizo con Facebook: no tiene una clave que cambiar. Si el permiso se pierde, se vuelve a conectar
              con el mismo botón.
            </p>
            {/* No se dibuja si la instalación no tiene habilitado el botón. */}
            <FacebookSignupButton reconnectConnectionId={connection.id} />
          </div>
        ) : null}
      </section>

      {showConnected ? (
        <ConnectedNotice
          account={words.title}
          firstMessage={connection.lastInboundAt ? since(connection.lastInboundAt) || null : null}
          requested={fresh?.templates?.requested ?? null}
          inReview={connection.messages?.enRevision ?? null}
          messagesProblem={fresh?.templates?.error ?? null}
          onSeeMessages={() => {
            setConnectedDismissed(true)
            messagesHeading.current?.focus()
            messagesHeading.current?.scrollIntoView({ block: "start" })
          }}
        />
      ) : null}

      {showSteps ? (
        <WhatsAppConnectSteps
          title="Termina de conectar WhatsApp"
          connection={connection}
          account={words.title}
          created={showingFound ? fresh : null}
          step={showingFound ? 1 : (step ?? 3)}
          setup={setupQuery.data?.data}
          setupPending={setupQuery.isPending}
          setupFailed={setupQuery.isError}
          requested={fresh?.templates?.requested ?? null}
          onContinue={onFreshRead}
          onChangeKey={openKey}
          onRetrySetup={() => void setupQuery.refetch()}
        />
      ) : null}

      {active ? (
        <WhatsAppMessages
          items={items}
          isPending={messagesQuery.isPending}
          isError={messagesQuery.isError}
          account={showAccount ? words.title : null}
          since={since}
          canWrite={canWrite}
          openId={openId}
          syncing={sync.isPending}
          syncError={syncError}
          fixedCreate={fixedCreate}
          headingRef={messagesHeading}
          onRetry={() => void messagesQuery.refetch()}
          onSync={() => sync.mutate()}
          onOpen={(item) => openMessagePanel(item.id)}
          onCreate={() => openMessagePanel(null)}
        />
      ) : null}

      {canWrite && active && fixedCreate ? (
        // En teléfono, la acción principal queda fija al pie.
        <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-canvas px-4 py-3 sm:hidden">
          <Button type="button" className="h-12 w-full text-base" onClick={() => openMessagePanel(null)}>
            Nuevo mensaje
          </Button>
        </div>
      ) : null}

      {/* Una sola superficie lateral a la vez; `key` la reinicia al abrir otro mensaje. */}
      {surface?.kind === "message" ? (
        <WhatsAppMessagePanel
          key={surface.opening}
          connectionId={connection.id}
          message={openMessage}
          loading={surface.id !== null && openMessage === null}
          newData={ownMessageData(items ?? [])}
          canWrite={canWrite}
          canOpenAgent={canOpenAgent}
          since={since}
          onClose={() => setSurface(null)}
          onCreated={(item) => setSurface({ ...surface, id: item.id })}
        />
      ) : null}
      {surface?.kind === "key" ? <KeyPanel connectionId={connection.id} onClose={() => setSurface(null)} onChanged={keyChanged} /> : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false)
          setStatus.reset()
        }}
        onConfirm={() => setStatus.mutate("disable")}
        title="Desconectar WhatsApp"
        description={WHATSAPP_DISCONNECT_CONSEQUENCE}
        confirmLabel="Desconectar"
        pending={setStatus.isPending}
      >
        {statusError ? (
          <p role="alert" className="text-sm text-destructive">
            {statusError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
