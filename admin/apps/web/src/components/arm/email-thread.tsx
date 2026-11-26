/**
 * El hilo de un correo en la Bandeja (ADR 0196): lo que nos escribieron y lo que les respondimos,
 * en orden, aunque llegue en varios correos; la respuesta que dejó lista Kairós con su porqué, y
 * el editor de respuesta. Se abre por cualquier correo del hilo (`/api/admin/inbox/correo/:id`).
 *
 * Responder sale por correo, en el mismo hilo, desde la dirección que dice el servidor. Si Kairós
 * dejó la respuesta lista y no se agregan archivos, «Enviar» es su sí con lo que cambiaste; con
 * archivos sale como respuesta tuya y su borrador se cierra. Lo incierto queda «¿Salió?»: nunca se
 * reenvía solo. Es solo de Administración.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import {
  AgentMark,
  common,
  ErrorState,
  FormDrawer,
  FormPanel,
  LoadingState,
  PageNotice,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { useAdminUserId, useIsAdmin } from "../../lib/session"
import { supportDayTime } from "../../lib/support-words"
import { clientFileHref, useMarkCarga } from "./client-files-tab"
import { ClientSearch } from "./client-search"
import { FormattedText } from "./formatted-body"
import { ClientName, invalidateArm } from "./hoy-links"
import {
  approveKairosReply,
  attendEmailThread,
  CLIENT_PHASE_WORDS,
  type EmailThread,
  emailThreadKey,
  settleConversation,
  type ThreadEntry,
  unsettleConversation,
  useEmailThread,
} from "./inbox-api"
import { NewClientDrawer, type NewClientValues } from "./new-client-drawer"
import { ReplyEditor, replyTextProblem } from "./reply-editor"
import { ReplyFiles } from "./reply-files"
import { resolveOutreach, SendUnknownError, sendEmailReply } from "./sale-api"

const enc = encodeURIComponent

const REPLY_STATUS_WORDS: Record<string, string> = {
  pendiente: "Saliendo…",
  enviado: "Salió",
  incierto: "No se sabe si salió",
  no_salio: "No salió",
}

const MAILBOX_WORDS: Record<string, string> = {
  soporte: "soporte@",
  contacto: "contacto@",
  hola: "hola@",
  fundadores: "fundadores@",
}

/** A dónde llegó: el buzón o la dirección de la persona del equipo. */
const mailboxWords = (mailbox: string, to: string) =>
  MAILBOX_WORDS[mailbox] ?? `${to.split("@")[0] ?? to}@`

const senderWords = (entry: Extract<ThreadEntry, { kind: "entro" }>) =>
  entry.fromName ? `${entry.fromName} <${entry.fromAddress}>` : entry.fromAddress

export function EmailThreadView({
  emailId,
  layout,
  onClose,
  onDirtyChange,
}: {
  emailId: string
  layout: "drawer" | "pane"
  onClose: () => void
  /** El panel dice si tiene algo escrito sin enviar (la Bandeja pregunta antes de cambiar). */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const thread = useEmailThread(emailId)
  if (!thread.data) {
    const body = thread.isError ? (
      <ErrorState
        title="No pude abrir el correo"
        error={thread.error}
        onRetry={() => void thread.refetch()}
      />
    ) : (
      <LoadingState message="Abriendo el correo…" />
    )
    if (layout === "pane")
      return (
        <div className="flex flex-col gap-3">
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Volver a la lista
            </Button>
          </div>
          {body}
        </div>
      )
    return (
      <FormDrawer
        open
        onClose={onClose}
        title="Correo"
        onSubmit={(event) => event.preventDefault()}
        isLoading={thread.isPending}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {body}
      </FormDrawer>
    )
  }
  // Por hilo, no por su último correo: si llega otro mientras se escribe, lo escrito sigue ahí.
  return (
    <Conversation
      key={thread.data.threadKey}
      thread={thread.data}
      layout={layout}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
    />
  )
}

type Aside = { kind: "ninguno" } | { kind: "elegir" } | { kind: "crear" }

function Conversation({
  thread,
  layout,
  onClose,
  onDirtyChange,
}: {
  thread: EmailThread
  layout: "drawer" | "pane"
  onClose: () => void
  onDirtyChange?: ((dirty: boolean) => void) | undefined
}) {
  const queryClient = useQueryClient()
  const isAdmin = useIsAdmin()
  const myUserId = useAdminUserId()
  const [aside, setAside] = useState<Aside>({ kind: "ninguno" })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: emailThreadKey(thread.emailId) })
    invalidateArm(queryClient, thread.client?.id ?? null)
  }
  const attend = useMutation({
    mutationFn: (on: boolean) => attendEmailThread(thread.reply.emailId, on),
    onSuccess: (_data, on) => toast.success(on ? "Lo atiendes tú" : "Ya no lo atiendes"),
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: refresh,
  })
  const settle = useMutation({
    mutationFn: (on: boolean) =>
      on ? settleConversation("correo", thread.reply.emailId) : unsettleConversation("correo", thread.reply.emailId),
    onSuccess: (_data, on) =>
      toast.success(on ? "Listo: ya no espera respuesta" : "Vuelve a esperar respuesta"),
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: refresh,
  })
  const assign = useMutation({
    mutationFn: (clientId: string) =>
      api(`/api/admin/clients/inbound/${enc(thread.reply.emailId)}/assign`, {
        method: "POST",
        body: JSON.stringify({ clientId }),
      }),
    onSuccess: () => {
      toast.success("Listo: el correo y su hilo quedan en esa ficha")
      setAside({ kind: "ninguno" })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: refresh,
  })

  const draft = thread.draft
  // El borrador de Kairós se aprueba solo si responde el correo que se está respondiendo; si llegó
  // otro después, se lo ve como sugerencia y sale como respuesta tuya.
  const draftAnswersThis = Boolean(draft && (!draft.emailId || draft.emailId === thread.reply.emailId))
  const schema = z
    .object({ body: z.string(), fileIds: z.array(z.string()).max(5, "Adjunta como máximo 5 documentos") })
    .superRefine((value, ctx) => {
      if (!value.body.trim()) ctx.addIssue({ code: "custom", path: ["body"], message: "Escribe la respuesta" })
      const problem = replyTextProblem(value.body, "correo", thread.rules)
      if (problem) ctx.addIssue({ code: "custom", path: ["body"], message: problem })
    })
  // Lo de partida se fija una vez: si el borrador cambia con una recarga, no pisa lo escrito.
  const [initial] = useState(() => ({ body: draft?.body ?? "", fileIds: [] as string[] }))
  const [loadedDraft, setLoadedDraft] = useState(draft?.itemId ?? null)
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      const body = value.body.trim()
      try {
        if (draft && draftAnswersThis && value.fileIds.length === 0) {
          const decision = await approveKairosReply(draft.itemId, body)
          if (decision.status === "vencida" || decision.status === "fallida") {
            toast.error(decision.error ?? "No se pudo enviar: el borrador ya no vale. Escríbela de nuevo.")
            return
          }
          if (decision.status === "incierta")
            toast.warning("No se sabe si salió: no se reintenta. Revísalo abajo y di si salió.")
          else toast.success(`Respuesta enviada a ${thread.reply.to}`)
        } else {
          await sendEmailReply(thread.reply.emailId, {
            body,
            ...(value.fileIds.length ? { fileIds: value.fileIds } : {}),
          })
          toast.success(`Respuesta enviada a ${thread.reply.to}`)
        }
        formApi.reset({ body: "", fileIds: [] })
      } catch (error) {
        if (!(error instanceof SendUnknownError)) throw error
        formApi.reset({ body: "", fileIds: [] })
        toast.warning("No se sabe si salió: no se reintenta. Revísalo abajo y di si salió.")
      } finally {
        refresh()
      }
    },
  })
  // Desde el sí de Kairós el servidor señala el texto como `edited.body`.
  const surface = useFormSurface(form, { fieldMap: { "edited.body": "body" } })
  useEffect(() => {
    onDirtyChange?.(surface.isDirty)
  }, [surface.isDirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  // Un borrador nuevo de Kairós entra solo si no se está escribiendo nada.
  useEffect(() => {
    if (!draft || draft.itemId === loadedDraft) return
    setLoadedDraft(draft.itemId)
    if (!form.getFieldValue("body").trim()) form.setFieldValue("body", draft.body)
  }, [draft, loadedDraft, form])

  const attendedByMe = thread.attendedBy?.id === myUserId
  const settled = thread.state === "respondida" && Boolean(thread.settledAt)
  // Lo que llegó a gestorIA no se liga a un cliente: los de la administración son de las clínicas.
  const linkable = isClinicalProduct(thread.product)
  const firstIn = thread.entries.find((entry) => entry.kind === "entro")
  const title = thread.subject?.trim() || "Correo sin asunto"
  const description = firstIn
    ? `De ${senderWords(firstIn)} · a ${mailboxWords(thread.mailbox, firstIn.to)}`
    : `A ${MAILBOX_WORDS[thread.mailbox] ?? thread.mailbox}`

  const asideDrawer =
    aside.kind === "elegir" ? (
      <AssignDrawer
        thread={thread}
        pending={assign.isPending}
        onAssign={(clientId) => assign.mutate(clientId)}
        onClose={() => setAside({ kind: "ninguno" })}
      />
    ) : aside.kind === "crear" && firstIn ? (
      <NewClientDrawer
        open
        title="Crear cliente con este correo"
        initial={newClientFromThread(thread, firstIn)}
        onCreated={async (clientId) => {
          await assign.mutateAsync(clientId)
        }}
        onClose={() => setAside({ kind: "ninguno" })}
      />
    ) : null
  // En un cajón, lo de al lado lo reemplaza; en el panel se abre junto al hilo, sin perder lo escrito.
  if (asideDrawer && layout === "drawer") return asideDrawer

  const content = (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {thread.client ? (
          <ClientName clientId={thread.client.id} tab="historial">
            Ver la ficha de {thread.client.name}
          </ClientName>
        ) : (
          <span className="text-muted-foreground">
            {linkable ? "Sin cliente todavía" : "Llegó a gestorIA: se atiende aquí, sin cliente"}
          </span>
        )}
        {thread.client ? (
          <span className="text-muted-foreground">· {CLIENT_PHASE_WORDS[thread.client.phase]}</span>
        ) : null}
        {thread.attendedBy ? (
          <span className="text-muted-foreground">
            {attendedByMe ? "· Lo atiendes tú" : `· Lo atiende ${thread.attendedBy.name.trim().split(/\s+/)[0]}`}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={attend.isPending}
            onClick={() => attend.mutate(!attendedByMe)}
          >
            {attendedByMe ? "Ya no lo atiendo" : "Lo atiendo yo"}
          </Button>
          {thread.state === "te_toca" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={settle.isPending}
              onClick={() => settle.mutate(true)}
            >
              No necesita respuesta
            </Button>
          ) : settled ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={settle.isPending}
              onClick={() => settle.mutate(false)}
            >
              Volver a «Te toca»
            </Button>
          ) : null}
        </div>
      </div>

      {!thread.client && isAdmin && linkable ? (
        <PageNotice
          tone="aviso"
          label="¿De quién es?"
          action={
            <div className="flex flex-wrap gap-2">
              {thread.suggestion ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={assign.isPending}
                  onClick={() => thread.suggestion && assign.mutate(thread.suggestion.clientId)}
                >
                  Es de {thread.suggestion.clientName}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={() => setAside({ kind: "elegir" })}>
                Elegir el cliente
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAside({ kind: "crear" })}>
                Crear cliente con este correo
              </Button>
            </div>
          }
        >
          {thread.suggestion
            ? `Puede ser de ${thread.suggestion.clientName}: ${thread.suggestion.why}. Nada se liga solo.`
            : "Liga el correo a su cliente para verlo en su ficha y poder mandarle archivos."}
        </PageNotice>
      ) : null}

      {thread.client?.phase === "activo" ? (
        <p className="text-sm text-muted-foreground">
          Ya usa su app: si es una consulta de uso, la ayuda va por Soporte, dentro de su app.
        </p>
      ) : null}

      <ol aria-label="El hilo" className="flex flex-col gap-3">
        {thread.entries.map((entry) =>
          entry.kind === "entro" ? (
            <Inbound key={entry.id} entry={entry} clientId={thread.client?.id ?? null} onChanged={refresh} />
          ) : (
            <Outbound key={entry.id} entry={entry} onChanged={refresh} />
          ),
        )}
      </ol>

      <section
        aria-labelledby={`correo-responder-${thread.emailId}`}
        className="flex flex-col gap-3 border-t pt-4"
      >
        <h3 id={`correo-responder-${thread.emailId}`} className="text-sm font-semibold">
          Responder por correo
        </h3>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          A {thread.reply.to}
          {thread.reply.from ? ` · desde ${thread.reply.from}` : ""} · «{thread.reply.subject}»
        </p>
        {draft ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <AgentMark size="sm" className="size-4" />
              {draftAnswersThis
                ? "Kairós dejó esta respuesta: cámbiala si hace falta y envíala."
                : "Kairós la dejó para un correo anterior: revísala antes de enviarla, que llegó otro después."}
            </p>
            {draft.reason ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Por qué:</span> {draft.reason}
              </p>
            ) : null}
            {draft.facts.length > 0 ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">En qué se basó:</span>{" "}
                {draft.facts.join(" · ")}
              </p>
            ) : null}
            {draft.note ? <p className="text-xs text-muted-foreground">{draft.note}</p> : null}
          </div>
        ) : null}
        {thread.reply.canReply ? (
          <form.AppField name="body">
            {(field) => (
              <field.Control
                label="Respuesta"
                hideLabel
                description="Sale en el mismo hilo, con tu firma y el correo que respondes debajo."
              >
                {(control) => (
                  <ReplyEditor
                    control={control.props}
                    value={field.state.value}
                    onChange={field.handleChange}
                    channel="correo"
                    rules={thread.rules}
                    rows={7}
                    improve={{ emailId: thread.reply.emailId }}
                    below={
                      thread.client ? (
                        <form.Field name="fileIds">
                          {(files) => (
                            <ReplyFiles
                              clientId={thread.client?.id ?? ""}
                              isAdmin={isAdmin}
                              value={files.state.value}
                              onChange={files.handleChange}
                              error={
                                files.state.meta.errors
                                  .map((issue) => (typeof issue === "string" ? issue : issue?.message))
                                  .find(Boolean) ?? null
                              }
                            />
                          )}
                        </form.Field>
                      ) : null
                    }
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : (
          <PageNotice tone="aviso" label="No se puede responder aquí">
            {thread.reply.why ?? "Este correo no se puede responder desde la administración."}
          </PageNotice>
        )}
      </section>
    </div>
  )

  return layout === "pane" ? (
    <>
    <FormPanel
      {...surface}
      onClose={onClose}
      title={title}
      description={description}
      hideSubmit={!thread.reply.canReply}
      submitLabel={draft && draftAnswersThis ? "Enviar la respuesta" : "Enviar"}
      cancelLabel={common.actions.close}
      className="h-full"
    >
      {content}
    </FormPanel>
    {asideDrawer}
    </>
  ) : (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={title}
      description={description}
      hideSubmit={!thread.reply.canReply}
      submitLabel={draft ? "Enviar la respuesta" : "Enviar"}
      cancelLabel={common.actions.close}
    >
      {content}
    </FormDrawer>
  )
}

function Inbound({
  entry,
  clientId,
  onChanged,
}: {
  entry: Extract<ThreadEntry, { kind: "entro" }>
  clientId: string | null
  onChanged: () => void
}) {
  const isAdmin = useIsAdmin()
  const carga = useMarkCarga(clientId, onChanged)
  return (
    <li className="mr-6 flex flex-col gap-2 rounded-xl rounded-tl-none bg-muted p-3 text-sm sm:mr-12">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {senderWords(entry)} · {supportDayTime(entry.at)}
      </p>
      {!entry.senderVerified ? (
        <p className="text-xs text-muted-foreground">
          No pudimos comprobar que lo mandó esa dirección: no se ligó solo a ningún cliente.
        </p>
      ) : null}
      {entry.text ? (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.text}</p>
      ) : (
        <p className="text-muted-foreground">
          {entry.textDeleted ? "El texto se borró a los 30 días de llegar." : "Llegó sin texto."}
        </p>
      )}
      {entry.notice ? <p className="text-xs text-muted-foreground">{entry.notice}</p> : null}
      {entry.attachments.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {entry.attachments.map((file, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: dos adjuntos pueden llamarse igual.
              key={`${file.fileId ?? file.filename}-${index}`}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-background/70 px-2.5 py-1.5"
            >
              <Paperclip aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{file.filename}</span>
              {file.fileId ? (
                <a
                  className="text-xs text-primary underline underline-offset-2"
                  href={clientFileHref(file.fileId)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Descargar
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">No se guardó</span>
              )}
              {file.fileId && clientId && isAdmin ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    file.fileId &&
                    carga.ask({
                      fileId: file.fileId,
                      filename: file.filename,
                      cargaDeleteAfter: file.cargaDeleteAfter,
                      cargaDueNow: file.cargaDueNow,
                    })
                  }
                >
                  Es la carga de datos
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {carga.dialog}
    </li>
  )
}

function Outbound({
  entry,
  onChanged,
}: {
  entry: Extract<ThreadEntry, { kind: "salio" }>
  onChanged: () => void
}) {
  const resolve = useMutation({
    mutationFn: (outcome: "salio" | "no_salio") => resolveOutreach(entry.id, outcome),
    onSuccess: (_data, outcome) => {
      toast.success(outcome === "salio" ? "Anotado: salió" : "Anotado: no salió")
      onChanged()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const who = entry.byKairos ? "Kairós" : entry.by?.name?.trim() || "El equipo"
  return (
    <li className="ml-6 flex flex-col gap-2 rounded-xl rounded-tr-none border bg-card p-3 text-sm sm:ml-12">
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {entry.byKairos ? <AgentMark size="sm" className="size-4" /> : null}
        <span>
          {who} · {supportDayTime(entry.sentAt ?? entry.at)} · {REPLY_STATUS_WORDS[entry.status] ?? entry.status}
        </span>
      </p>
      <FormattedText text={entry.body} />
      {entry.files.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <Paperclip aria-hidden className="size-3.5" />
          {entry.files.map((file) => file.filename).join(" · ")}
        </p>
      ) : null}
      {entry.canResolve ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">¿Salió?</span>
          <Button type="button" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate("salio")}>
            Salió
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate("no_salio")}
          >
            No salió
          </Button>
        </div>
      ) : null}
    </li>
  )
}

/** Ligar el correo (y su hilo) a un cliente que ya existe. */
function AssignDrawer({
  thread,
  pending,
  onAssign,
  onClose,
}: {
  thread: EmailThread
  pending: boolean
  onAssign: (clientId: string) => void
  onClose: () => void
}) {
  const firstIn = thread.entries.find((entry) => entry.kind === "entro")
  const form = useAppForm({
    defaultValues: { clientId: "" },
    validators: { onSubmit: z.object({ clientId: z.string().min(1, "Elige el cliente") }) },
    onSubmit: ({ value }) => onAssign(value.clientId),
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      isSubmitting={surface.isSubmitting || pending}
      open
      onClose={onClose}
      title="¿De quién es este correo?"
      description={firstIn ? `De ${senderWords(firstIn)}` : undefined}
      submitLabel="Ligar a este cliente"
      cancelLabel={common.actions.cancel}
    >
      <form.AppField name="clientId">
        {(field) => (
          <field.Control label="Cliente">
            {(control) => (
              <ClientSearch
                id="correo-buscar-cliente"
                initialQuery={firstIn?.fromName ?? ""}
                control={control}
                value={field.state.value}
                onChange={(clientId) => field.handleChange(clientId)}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
    </FormDrawer>
  )
}

/** Lo que se sabe del remitente para «Crear cliente con este correo». */
function newClientFromThread(
  thread: EmailThread,
  first: Extract<ThreadEntry, { kind: "entro" }>,
): Partial<NewClientValues> {
  const product = thread.product
  return {
    contactName: first.fromName ?? "",
    email: first.fromAddress,
    ...(product && (CLINICAL_PRODUCTS as readonly string[]).includes(product)
      ? { product: product as ClinicalProduct }
      : {}),
    origin: "otro",
    originDetail: `Nos escribió a ${mailboxWords(thread.mailbox, first.to)}`,
  }
}
