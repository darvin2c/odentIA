import { Badge, Button, buttonVariants, cn, Field, FieldDescription, FieldLabel, Input, Textarea, toast } from "@odentia/ui"
import { ConfirmDialog, FormDrawer } from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, TriangleAlert } from "lucide-react"
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { ApiError, apiFetch } from "../../../lib/api"
import {
  type ClinicMessage,
  dataToken,
  insertAtCursor,
  type MessageCheck,
  type MessageData,
  messageSource,
  STATUS_EXPLAINED,
  STATUS_TONE,
  type StatusTone,
  statusDetail,
  statusWords,
  toFieldText,
  toServerBody,
  whatsappMessagesKey,
} from "../../../lib/whatsapp"
import { MessagePreview } from "./message-preview"
import { Note, type NoteTone } from "./note"

const STATUS_NOTE: Record<StatusTone, NoteTone> = { ok: "ok", waiting: "waiting", danger: "danger", off: "plain" }
const STATUS_BADGE = { ok: "soft", waiting: "warning", danger: "destructive", off: "secondary" } as const
const SECTION_TITLE = "text-sm font-semibold"

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.shape.message ? error.shape.message : fallback
}

/** El motivo llega con las palabras del servidor (o de WhatsApp): solo se le asegura el punto final. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** El último valor que lleva quieto `ms`: para no preguntarle al servidor en cada tecla. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** Ver un mensaje: cómo está, cómo le llega a la persona, qué hacen sus botones y qué línea lo usa. */
function MessageView({
  item,
  since,
  notice,
  canWrite,
  canOpenAgent,
  busy,
  editRef,
  onEdit,
  onRevert,
  onDelete,
}: {
  item: ClinicMessage
  since: (iso: string) => string
  notice: string | null
  canWrite: boolean
  canOpenAgent: boolean
  busy: boolean
  /** Al volver de editar, el foco regresa a este botón. */
  editRef: RefObject<HTMLButtonElement | null>
  onEdit: () => void
  onRevert: () => void
  onDelete: () => void
}) {
  const tone = STATUS_TONE[item.current.status]
  const detail = statusDetail(item, since)
  const explained = STATUS_EXPLAINED[item.current.status]
  const buttons = item.buttons.map((button) => button.title)
  const stopped = item.current.status === "rechazada" || item.current.status === "deshabilitada"

  return (
    <div className="flex flex-col gap-5">
      {notice ? (
        <p role="status" className="text-sm font-medium text-success">
          {notice}
        </p>
      ) : null}

      {/* El estado con las palabras del servidor; el motivo y lo que pasa mientras tanto, también. */}
      <Note tone={STATUS_NOTE[tone]} title={item.current.statusLabel}>
        {detail ? <span>{detail}</span> : null}
        {explained ? <span>{explained}</span> : null}
        {item.current.reason ? <span>Motivo: {sentence(item.current.reason)}</span> : null}
        {item.meanwhile && !item.pending ? <span>{item.meanwhile}</span> : null}
      </Note>

      <section aria-label="Así le llega a la persona" className="flex flex-col gap-1.5">
        <h3 className={SECTION_TITLE}>Así le llega a la persona</h3>
        <MessagePreview parts={item.current.previewParts} buttons={buttons} />
        <p className="text-sm text-muted-foreground">
          {item.origin === "cuenta"
            ? "Lo resaltado lo escribe quien envía el mensaje desde la Bandeja."
            : "Lo resaltado lo pone el sistema al enviar. Aquí son datos de ejemplo."}
        </p>
      </section>

      {item.pending ? (
        <section aria-label="Tu cambio de texto" className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={SECTION_TITLE}>Tu cambio de texto</h3>
            <Badge variant={STATUS_BADGE[STATUS_TONE[item.pending.status]]}>{statusWords(item.pending, since)}</Badge>
          </div>
          {item.meanwhile ? <p className="text-sm">{item.meanwhile}</p> : null}
          {item.pending.reason ? <p className="text-sm">Motivo: {sentence(item.pending.reason)}</p> : null}
          <MessagePreview parts={item.pending.previewParts} buttons={buttons} />
        </section>
      ) : null}

      {canWrite && item.editable ? (
        <Button ref={editRef} type="button" variant={stopped ? "default" : "outline"} className="min-h-11" disabled={busy} onClick={onEdit}>
          {item.current.status === "deshabilitada" ? "Editar y volver a pedir" : "Editar el texto"}
        </Button>
      ) : null}

      {item.buttons.length > 0 ? (
        <section aria-label="Qué pasa cuando toca un botón" className="flex flex-col gap-1.5">
          <h3 className={SECTION_TITLE}>Qué pasa cuando toca un botón</h3>
          <dl className="flex flex-col rounded-xl border text-sm">
            {item.buttons.map((button) => (
              <div key={button.title} className="flex flex-col gap-x-2.5 gap-y-0.5 border-t px-3 py-2 first:border-t-0 @sm:flex-row">
                <dt className="shrink-0 font-semibold @sm:w-28">{button.title}</dt>
                <dd className="text-muted-foreground">{button.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {item.line ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2.5">
          <div className="flex min-w-0 flex-1 basis-48 flex-col text-sm">
            <strong className="font-semibold">Lo usa la línea «{item.line.title}»</strong>
            <span className="text-muted-foreground">
              {item.line.enabled ? "Prendida" : "Apagada"}
              {item.when ? ` · ${item.when}` : ""}
            </span>
          </div>
          {/* La línea vive en Agente: solo se ofrece a quien puede abrirlo. */}
          {canOpenAgent ? (
            <Link
              to="/agent/administrador"
              search={{ linea: item.line.key }}
              className={cn(buttonVariants({ variant: "outline" }), "min-h-11 shrink-0 sm:min-h-9")}
            >
              Ver la línea
            </Link>
          ) : null}
        </div>
      ) : null}

      {item.origin === "agente" ? (
        <p className="text-sm text-muted-foreground">
          Por dónde sale: como respuesta si la persona escribió en las últimas 24 horas; con este mensaje aprobado si no; por
          correo si no tiene WhatsApp.
        </p>
      ) : null}
      {item.origin === "cuenta" ? (
        <p className="text-sm text-muted-foreground">
          Se creó en la página de Meta: ahí se le cambia el texto y ahí se elimina.
        </p>
      ) : null}

      {canWrite && (item.canRevert || item.deletable) ? (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {item.canRevert ? (
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={busy} onClick={onRevert}>
              Volver al texto de odentIA
            </Button>
          ) : null}
          {item.deletable ? (
            <Button type="button" variant="destructive" className="min-h-11 sm:min-h-9" disabled={busy} onClick={onDelete}>
              Eliminar
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Un mensaje de WhatsApp abierto al lado: verlo, cambiarle el texto o crear uno
 * nuevo. Es una sola superficie para las tres vistas —cambiar de vista no la
 * cierra ni la mueve de la columna al cajón—.
 *
 * El texto se escribe con cada dato como su nombre entre corchetes; al servidor
 * viaja con los datos por nombre. Las reglas del texto no viven aquí: la
 * pantalla muestra las comprobaciones y la vista previa que devuelve el servidor.
 */
export function WhatsAppMessagePanel({
  connectionId,
  message,
  loading = false,
  newData,
  canWrite,
  canOpenAgent,
  since,
  onClose,
  onCreated,
}: {
  connectionId: string
  /** El mensaje tal como está en la lista; `null`: uno nuevo. */
  message: ClinicMessage | null
  /** El mensaje existe pero la lista aún no lo trae. */
  loading?: boolean
  /** Los datos que puede llevar un mensaje nuevo. */
  newData: MessageData[]
  canWrite: boolean
  canOpenAgent: boolean
  since: (iso: string) => string
  onClose: () => void
  /** Se creó: la pantalla sigue con él abierto. */
  onCreated: (item: ClinicMessage) => void
}) {
  const queryClient = useQueryClient()
  const base = `/api/channels/connections/${connectionId}/messages`
  const creating = message === null && !loading
  const [editing, setEditing] = useState(false)
  const mode: "view" | "edit" = creating || editing ? "edit" : "view"
  const data = creating ? newData : (message?.variables ?? [])

  // El borrador vive aquí: que la lista se actualice por debajo no lo toca.
  const [draft, setDraft] = useState("")
  const [opened, setOpened] = useState("")
  const [title, setTitle] = useState("")
  const [buttonTitle, setButtonTitle] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<"delete" | "revert" | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const textId = useId()
  const titleId = useId()
  const buttonId = useId()

  const isDirty =
    mode === "edit" && (creating ? [draft, title, buttonTitle].some((value) => value.trim() !== "") : draft !== opened)
  const body = toServerBody(draft, data)

  // Al pasar de ver a editar (o al volver), la superficie empieza arriba y el foco no se pierde
  // con el botón que desaparece: va al texto o regresa a «Editar el texto».
  const shownMode = useRef(mode)
  useEffect(() => {
    if (shownMode.current === mode) return
    shownMode.current = mode
    top.current?.closest("[data-slot=scroll-area-viewport]")?.scrollTo({ top: 0 })
    if (mode === "edit") {
      // El cursor empieza al final: ahí cae lo primero que se escriba o se ponga con un botón.
      const end = textarea.current?.value.length ?? 0
      textarea.current?.focus({ preventScroll: true })
      textarea.current?.setSelectionRange(end, end)
    } else editButton.current?.focus({ preventScroll: true })
  }, [mode])

  const request = JSON.stringify(creating ? { title, body, buttonTitle } : { messageId: message?.id, body })
  const settled = useSettled(request, 400)
  const checkQuery = useQuery({
    queryKey: ["whatsapp-message-check", connectionId, settled],
    queryFn: () => apiFetch<{ data: MessageCheck }>(`${base}/check`, { method: "POST", body: settled }),
    // Uno nuevo no se comprueba hasta que haya algo escrito: no se abre con errores.
    enabled: mode === "edit" && canWrite && (creating ? isDirty : true),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  })
  const check = checkQuery.data?.data
  const checkIsCurrent = settled === request && !checkQuery.isPlaceholderData && !checkQuery.isFetching

  function store(item: ClinicMessage) {
    const key = whatsappMessagesKey(connectionId)
    queryClient.setQueryData<{ data: ClinicMessage[] }>(key, (current) =>
      current
        ? {
            data: current.data.some((entry) => entry.id === item.id)
              ? current.data.map((entry) => (entry.id === item.id ? item : entry))
              : [...current.data, item],
          }
        : current,
    )
    void queryClient.invalidateQueries({ queryKey: key })
    // Las cuentas de la conexión (aprobados, en revisión) cambian con cada texto.
    void queryClient.invalidateQueries({ queryKey: ["connections"] })
  }

  const save = useMutation({
    mutationFn: () =>
      creating
        ? apiFetch<{ data: ClinicMessage }>(base, {
            method: "POST",
            body: JSON.stringify({
              title: title.trim(),
              body,
              ...(buttonTitle.trim() ? { buttonTitle: buttonTitle.trim() } : {}),
            }),
          })
        : apiFetch<{ data: ClinicMessage }>(`${base}/${encodeURIComponent(message?.id ?? "")}/text`, {
            method: "PUT",
            body: JSON.stringify({ body }),
          }),
    onSuccess: ({ data: saved }) => {
      store(saved)
      setError(null)
      setEditing(false)
      // Lo que pasó lo dice la respuesta: un texto nuevo entra a revisión; volver a uno que ya
      // estaba (desistir de un cambio, o el de odentIA ya aprobado) no pide otra.
      setNotice(
        saved.pending || saved.current.status === "en_revision"
          ? "Enviado a revisión de WhatsApp."
          : "Guardado. Queda el texto que ves abajo.",
      )
      if (creating) onCreated(saved)
    },
    // Si WhatsApp o una regla del texto no lo aceptan, el servidor dice por qué.
    onError: (failure) => setError(errorText(failure, "No pudimos guardar el mensaje. Vuelve a intentarlo.")),
  })

  const revert = useMutation({
    mutationFn: () =>
      apiFetch<{ data: ClinicMessage }>(`${base}/${encodeURIComponent(message?.id ?? "")}/revert`, { method: "POST" }),
    onSuccess: ({ data: saved }) => {
      store(saved)
      setConfirming(null)
      setError(null)
      setEditing(false)
      setNotice(saved.pending ? "El texto de odentIA entró a revisión de WhatsApp." : "Listo: vuelve el texto de odentIA.")
    },
    onError: (failure) => {
      setConfirming(null)
      setError(errorText(failure, "No pudimos volver al texto de odentIA. Vuelve a intentarlo."))
    },
  })

  const remove = useMutation({
    mutationFn: () => apiFetch(`${base}/${encodeURIComponent(message?.id ?? "")}`, { method: "DELETE" }),
    onSuccess: () => {
      const key = whatsappMessagesKey(connectionId)
      queryClient.setQueryData<{ data: ClinicMessage[] }>(key, (current) =>
        current ? { data: current.data.filter((entry) => entry.id !== message?.id) } : current,
      )
      void queryClient.invalidateQueries({ queryKey: key })
      void queryClient.invalidateQueries({ queryKey: ["connections"] })
      setConfirming(null)
      toast.success("Mensaje eliminado")
      onClose()
    },
  })
  const removeError = remove.isError
    ? errorText(remove.error, "No pudimos eliminar el mensaje. Vuelve a intentarlo.")
    : null

  function startEdit() {
    if (!message) return
    // Si hay un cambio en espera o rechazado, se sigue desde ese texto: es el último que escribió la clínica.
    const text = toFieldText((message.pending ?? message.current).body, message.variables)
    setDraft(text)
    setOpened(text)
    setError(null)
    setNotice(null)
    setEditing(true)
  }

  /** «Cancelar» al editar vuelve a ver el mensaje; en lo demás cierra la superficie. */
  function close() {
    if (editing && message) {
      setEditing(false)
      setError(null)
      return
    }
    onClose()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (mode !== "edit" || !canWrite || !isDirty) return
    setError(null)
    save.mutate()
  }

  function put(item: MessageData) {
    const field = textarea.current
    const end = draft.length
    const next = insertAtCursor(draft, dataToken(item.label), field?.selectionStart ?? end, field?.selectionEnd ?? end)
    // El texto se pinta antes de mover el cursor: queda justo después del dato y se sigue escribiendo ahí.
    flushSync(() => setDraft(next.text))
    field?.focus()
    field?.setSelectionRange(next.cursor, next.cursor)
  }

  const busy = save.isPending || revert.isPending || remove.isPending
  const required = data.some((item) => item.required)
  const editButtons = creating ? (buttonTitle.trim() ? [buttonTitle.trim()] : []) : (message?.buttons ?? []).map((button) => button.title)
  const previewParts = check?.previewParts ?? (message ? (message.pending ?? message.current).previewParts : [])
  // Mientras no cambie nada, el texto vigente sigue saliendo solo si está aprobado.
  const keepsSending = message?.current.status === "aprobada"

  const heading = creating ? "Nuevo mensaje" : mode === "edit" ? `Editar «${message?.title ?? ""}»` : (message?.title ?? "Mensaje")
  const description = creating
    ? "Para que tu equipo lo envíe desde la Bandeja cuando ya pasaron las 24 horas."
    : message
      ? (message.when ?? messageSource(message))
      : undefined

  return (
    <>
      <FormDrawer
        open
        onClose={close}
        title={heading}
        description={description}
        onSubmit={submit}
        isDirty={isDirty}
        isSubmitting={save.isPending}
        isLoading={loading}
        error={error}
        submitLabel="Enviar a revisión"
        cancelLabel={mode === "edit" ? "Cancelar" : "Cerrar"}
        hideSubmit={mode === "view" || !canWrite}
        submitDisabled={!isDirty || (checkIsCurrent && check !== undefined && !check.ok)}
      >
        <div ref={top} />
        {mode === "view" && message ? (
          <div className="@container">
            <MessageView
              item={message}
              since={since}
              notice={notice}
              canWrite={canWrite}
              canOpenAgent={canOpenAgent}
              busy={busy}
              editRef={editButton}
              onEdit={startEdit}
              onRevert={() => setConfirming("revert")}
              onDelete={() => {
                remove.reset()
                setConfirming("delete")
              }}
            />
          </div>
        ) : mode === "edit" ? (
          <div className="flex flex-col gap-5">
            <div id={`${textId}-aviso`}>
              {creating ? (
                <Note tone="waiting" title="Al guardar, WhatsApp lo revisa">
                  <span>Puede tardar hasta un día. Mientras tanto no se ofrece en la Bandeja.</span>
                </Note>
              ) : keepsSending ? (
                <Note tone="waiting" title="Al guardar, WhatsApp lo revisa de nuevo">
                  <span>Puede tardar hasta un día. Mientras tanto sigue saliendo el texto actual.</span>
                </Note>
              ) : (
                <Note tone="waiting" title="Al guardar, WhatsApp lo revisa de nuevo">
                  <span>Puede tardar hasta un día.{message?.meanwhile ? ` ${message.meanwhile}` : ""}</span>
                </Note>
              )}
            </div>

            {creating ? (
              <Field>
                <FieldLabel htmlFor={titleId}>Para qué sirve</FieldLabel>
                <Input
                  id={titleId}
                  className="h-11 sm:h-9"
                  value={title}
                  aria-describedby={`${titleId}-ayuda`}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <FieldDescription id={`${titleId}-ayuda`}>
                  Con este nombre lo elige tu equipo en la Bandeja. La persona no lo ve.
                </FieldDescription>
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor={textId}>Texto</FieldLabel>
              <Textarea
                id={textId}
                ref={textarea}
                className="min-h-32"
                value={draft}
                aria-describedby={`${textId}-aviso ${textId}-ayuda`}
                onChange={(event) => setDraft(event.target.value)}
              />
              {data.length > 0 ? (
                <div role="group" aria-label="Datos que pone el sistema" className="flex flex-wrap gap-1.5">
                  {data.map((item) => (
                    <Button
                      key={item.key}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-11 max-w-full shrink py-1.5 text-left whitespace-normal sm:min-h-8"
                      onClick={() => put(item)}
                    >
                      Poner «{item.label}»
                    </Button>
                  ))}
                </div>
              ) : null}
              <FieldDescription id={`${textId}-ayuda`}>
                Lo que va entre corchetes lo pone el sistema al enviar; los botones de arriba lo ponen donde está el cursor.{" "}
                {required
                  ? "Se puede mover de sitio, no quitar: sin esos datos el mensaje no dice nada."
                  : "Puedes usarlos o no."}
              </FieldDescription>
            </Field>

            {creating ? (
              <Field>
                <FieldLabel htmlFor={buttonId}>Botón de respuesta (opcional)</FieldLabel>
                <Input
                  id={buttonId}
                  className="h-11 sm:h-9"
                  value={buttonTitle}
                  aria-describedby={`${buttonId}-ayuda`}
                  onChange={(event) => setButtonTitle(event.target.value)}
                />
                <FieldDescription id={`${buttonId}-ayuda`}>
                  Si lo pones, la persona responde con un toque y tu equipo puede seguir la conversación. Después de crear el
                  mensaje no se cambia.
                </FieldDescription>
              </Field>
            ) : editButtons.length > 0 ? (
              <section aria-label="Botones" className="flex flex-col gap-1.5">
                <h3 className={SECTION_TITLE}>Botones</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {editButtons.map((button) => (
                    <li key={button} className="rounded-full bg-muted px-3 py-1 text-sm font-semibold">
                      {button}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-muted-foreground">
                  No se cambian: de ellos depende lo que pasa cuando la persona los toca, como que la cita se confirme sola o
                  que deje de recibir estos mensajes.
                </p>
              </section>
            ) : null}

            <section aria-label="Así le llegará" className="flex flex-col gap-1.5">
              <h3 className={SECTION_TITLE}>Así le llegará</h3>
              {previewParts.length > 0 ? (
                <MessagePreview parts={previewParts} buttons={editButtons} />
              ) : (
                <p className="rounded-xl bg-muted px-3.5 py-3 text-sm text-muted-foreground">
                  Escribe el texto y aquí lo verás con datos de ejemplo.
                </p>
              )}
            </section>

            {/* Las comprobaciones son las del servidor, con sus frases: las mismas que al guardar. */}
            <div role="status" aria-label="Comprobaciones del texto">
              {check ? (
                <ul className="flex flex-col gap-1.5 rounded-xl bg-muted px-3.5 py-3 text-sm">
                  {check.checks.map((item) => (
                    <li key={item.text} className={cn("flex gap-2", item.ok ? "" : "font-medium text-destructive")}>
                      {item.ok ? (
                        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-soft-foreground" />
                      ) : (
                        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                      )}
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              ) : checkQuery.isFetching ? (
                <p className="text-sm text-muted-foreground">Comprobando el texto…</p>
              ) : checkQuery.isError ? (
                <p className="text-sm text-muted-foreground">
                  No pudimos comprobar el texto ahora. Al enviarlo a revisión se comprueba igual.
                </p>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">
              Si le agregas una oferta, WhatsApp puede contarlo como marketing y cobrarlo distinto.
            </p>

            {message && (message.canRevert || message.deletable) ? (
              <div className="flex flex-wrap gap-2 border-t pt-4">
                {message.canRevert ? (
                  <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" disabled={busy} onClick={() => setConfirming("revert")}>
                    Volver al texto de odentIA
                  </Button>
                ) : null}
                {message.deletable ? (
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11 sm:min-h-9"
                    disabled={busy}
                    onClick={() => {
                      remove.reset()
                      setConfirming("delete")
                    }}
                  >
                    Eliminar
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </FormDrawer>

      <ConfirmDialog
        open={confirming === "revert"}
        onClose={() => setConfirming(null)}
        onConfirm={() => revert.mutate()}
        variant="default"
        title="Volver al texto de odentIA"
        description="Se deja de usar el texto que escribió la clínica. Si el de odentIA ya está aprobado, sale desde ahora; si no, WhatsApp lo revisa primero y mientras tanto sigue saliendo el actual."
        confirmLabel="Volver al texto de odentIA"
        pending={revert.isPending}
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onClose={() => setConfirming(null)}
        onConfirm={() => remove.mutate()}
        title="Eliminar este mensaje"
        description={`«${message?.title ?? ""}» dejará de ofrecerse en la Bandeja y se quitará de tu cuenta de WhatsApp. Lo que ya se envió sigue en sus conversaciones.`}
        confirmLabel="Eliminar"
        pending={remove.isPending}
      >
        {removeError ? (
          <p role="alert" className="text-sm text-destructive">
            {removeError}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
