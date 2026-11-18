/**
 * Una conversación de la administración por WhatsApp, Instagram o Messenger
 * (`GET /api/admin/chats/:id`): sus mensajes por día, lo que le respondimos
 * con su estado, sus archivos (solo Administración, con «Es la carga de
 * datos», el mismo diálogo de Documentos) y la respuesta.
 *
 * Responder: texto libre solo dentro de las 24 h desde su último mensaje (lo
 * dice el servidor con `freeUntil`); después, en WhatsApp, «Retomar con la
 * plantilla», y en Instagram o Messenger, un correo o un WhatsApp. Sale una
 * sola vez: si no se sabe si salió queda «No se sabe si salió» con «¿Salió?»,
 * nunca se reenvía solo. Lo abren la tarjeta de Hoy, el Historial de la ficha
 * y «Escribir por WhatsApp» (Contactos, Venta, «Escribir»).
 *
 * Kairós (con «Kairós responde solo en los chats» prendido): mientras atiende
 * la conversación lo dice arriba y la respuesta a mano espera a «Lo atiendo
 * yo», que lo pausa solo aquí; «Devolver a Kairós» lo reanuda. Lo que escribió
 * va con su nombre y con en qué se basó, y si se la pasó al equipo se dice por qué.
 *
 * La misma conversación se ve en un cajón (`layout="drawer"`) y en el panel de
 * la Bandeja (`layout="pane"`), con el editor de respuesta de toda la
 * administración: el formato, el largo de cada canal y los archivos de
 * Documentos (cada uno sale como su propio mensaje). Es solo de Administración.
 */
import { Button, toast } from "@odentia/ui"
import {
  AgentMark,
  common,
  ErrorState,
  FormDrawer,
  FormPanel,
  LoadingState,
  PageNotice,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { useAdminUserId, useIsAdmin } from "../../lib/session"
import { ChatAppChange } from "./chat-app"
import { supportTime } from "../../lib/support-words"
import {
  assignChatTo,
  CHAT_CHANNEL_WORDS,
  type ChatDetail,
  type ChatEntry,
  ChatSendError,
  chatFileState,
  chatFileTypeWords,
  chatKey,
  chatSubtitle,
  chatTitle,
  entriesByDay,
  freeWindowWords,
  isUnsettled,
  kairosChatState,
  openChatOutcome,
  openChatWith,
  pauseKairos,
  replyHelpWords,
  resumeKairos,
  sendChatReply,
  sendChatRetomar,
  sentLineWords,
  useChat,
  waMeHref,
} from "./chat-api"
import { ChatOwnerDrawer, useNotClinic } from "./chat-owner-drawer"
import { useMarkCarga } from "./client-files-tab"
import { ClientName, invalidateArm } from "./hoy-links"
import {
  CLIENT_PHASE_WORDS,
  type ClientPhase,
  settleConversation,
  unsettleConversation,
} from "./inbox-api"
import { ReplyEditor, replyTextProblem } from "./reply-editor"
import { ReplyFiles } from "./reply-files"
import { resolveOutreach, useClientSale } from "./sale-api"
import { WriteDrawer } from "./write-drawer"

export interface ChatDrawerProps {
  chatId: string
  open: boolean
  onClose: () => void
  /** El texto con que empieza la respuesta («Escribir» por WhatsApp lo trae puesto). */
  draft?: string
  /**
   * «Enviar la propuesta» por WhatsApp: la primera respuesta que sale la lleva
   * (queda enviada como por correo); el PDF no va por WhatsApp.
   */
  proposalId?: string | null
  /**
   * Abre directo «¿De quién es?»: «Escribir por WhatsApp» encontró que ese
   * celular ya escribió sin decir de quién es (409 `CHAT_UNASSIGNED`).
   */
  decide?: boolean
  /** En un cajón (lo de siempre) o en el panel de la Bandeja. */
  layout?: "drawer" | "pane"
  /** El panel dice si tiene algo escrito sin enviar (la Bandeja pregunta antes de cambiar). */
  onDirtyChange?: (dirty: boolean) => void
}

export function ChatDrawer(props: ChatDrawerProps) {
  if (!props.open) return null
  return <ChatSurface key={props.chatId} {...props} />
}

/** La conversación en el panel de la Bandeja: la misma del cajón, en su lugar. */
export function ChatPane({
  chatId,
  onClose,
  onDirtyChange,
}: {
  chatId: string
  onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  return (
    <ChatSurface
      key={chatId}
      chatId={chatId}
      open
      onClose={onClose}
      layout="pane"
      onDirtyChange={onDirtyChange}
    />
  )
}

type Aside =
  | { kind: "ninguno" }
  | { kind: "mover" }
  | { kind: "decidir" }
  | { kind: "correo"; clientId: string; contactId: string | null }
  | { kind: "otro-chat"; chatId: string; decide?: boolean }

function ChatSurface({
  chatId,
  onClose,
  draft = "",
  proposalId = null,
  decide = false,
  layout = "drawer",
  onDirtyChange,
}: ChatDrawerProps) {
  const queryClient = useQueryClient()
  const chat = useChat(chatId)
  const [aside, setAside] = useState<Aside>(decide ? { kind: "decidir" } : { kind: "ninguno" })
  const refresh = (clientId: string | null | undefined) => {
    void queryClient.invalidateQueries({ queryKey: chatKey(chatId) })
    invalidateArm(queryClient, clientId)
    // Sin cliente, Hoy también cambia (lo que espera decidir o responder).
    if (clientId) invalidateArm(queryClient, null)
  }

  if (!chat.data && layout === "pane") {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Volver a la lista
          </Button>
        </div>
        {chat.isError ? (
          <ErrorState
            title="No pude abrir la conversación"
            error={chat.error}
            onRetry={() => void chat.refetch()}
          />
        ) : (
          <LoadingState message="Abriendo la conversación…" />
        )}
      </div>
    )
  }
  if (!chat.data) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title="Conversación"
        onSubmit={(event) => event.preventDefault()}
        isLoading={chat.isPending}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {chat.isError ? (
          <ErrorState
            title="No pude abrir la conversación"
            error={chat.error}
            onRetry={() => void chat.refetch()}
          />
        ) : (
          <LoadingState message="Abriendo la conversación…" />
        )}
      </FormDrawer>
    )
  }
  const data = chat.data

  if (aside.kind === "otro-chat")
    return (
      <ChatSurface
        key={aside.chatId}
        open
        chatId={aside.chatId}
        decide={aside.decide}
        onClose={onClose}
      />
    )
  const asideDrawer =
    aside.kind === "correo" ? (
      <WriteDrawer
        open
        clientId={aside.clientId}
        channel="correo"
        contactId={aside.contactId}
        onClose={() => setAside({ kind: "ninguno" })}
      />
    ) : aside.kind === "mover" || aside.kind === "decidir" ? (
      <ChatOwnerDrawer
        mode={aside.kind === "mover" ? "mover" : "decidir"}
        currentClientId={data.client?.id ?? null}
        subject={{
          chatId: data.id,
          channel: data.channel,
          address: data.address,
          displayName: data.displayName,
          lastBody: lastInbound(data)?.body ?? null,
          receivedAt: data.lastInboundAt,
          suggestion: data.suggestion,
        }}
        onAssign={async (input) => {
          await assignChatTo(data.id, input)
          refresh(data.client?.id)
          invalidateArm(queryClient, input.clientId)
          toast.success("Listo: sus mensajes quedan en esa ficha")
        }}
        onClose={() => setAside({ kind: "ninguno" })}
      />
    ) : null
  // En un cajón, lo de al lado lo reemplaza (un cajón a la vez); en el panel de la Bandeja se abre
  // junto a la conversación, que sigue montada con lo que se estaba escribiendo.
  if (asideDrawer && layout === "drawer") return asideDrawer
  return (
    <>
      <Conversation
        chat={data}
        draft={draft}
        proposalId={proposalId}
        layout={layout}
        onClose={onClose}
        onAside={setAside}
        onChanged={() => refresh(data.client?.id)}
        onDirtyChange={onDirtyChange}
      />
      {asideDrawer}
    </>
  )
}

const lastInbound = (chat: ChatDetail) =>
  [...chat.entries].reverse().find((entry) => entry.kind === "entro") as
    | Extract<ChatEntry, { kind: "entro" }>
    | undefined

/** El resultado de un envío dicho en un aviso: salió, no salió o no se sabe. */
function announceSent(status: string, channel: string, files = 0) {
  const extra = files ? (files === 1 ? " con su archivo" : ` con sus ${files} archivos`) : ""
  if (status === "enviado") toast.success(`Salió por ${channel}${extra}`)
  else toast.warning(`No se sabe si salió por ${channel}: no se reintenta. Revísalo y di si salió.`)
}

function Conversation({
  chat,
  draft,
  proposalId,
  layout,
  onClose,
  onAside,
  onChanged,
  onDirtyChange,
}: {
  chat: ChatDetail
  draft: string
  proposalId: string | null
  layout: "drawer" | "pane"
  onClose: () => void
  onAside: (aside: Aside) => void
  onChanged: () => void
  onDirtyChange?: ((dirty: boolean) => void) | undefined
}) {
  const isAdmin = useIsAdmin()
  const myUserId = useAdminUserId()
  const channel = CHAT_CHANNEL_WORDS[chat.channel]
  const { undo } = useNotClinic()
  const kairos = kairosChatState(chat, myUserId)
  const takeOver = useMutation({
    mutationFn: (mine: boolean) => (mine ? pauseKairos(chat.id) : resumeKairos(chat.id)),
    onSuccess: (_data, mine) =>
      toast.success(
        mine
          ? kairos
            ? "Lo atiendes tú: Kairós no responde solo en esta conversación"
            : "Lo atiendes tú"
          : "Kairós vuelve a responder aquí lo que siga sin respuesta y lo que llegue",
      ),
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: onChanged,
  })
  const settle = useMutation({
    mutationFn: (on: boolean) =>
      on ? settleConversation("chat", chat.id) : unsettleConversation("chat", chat.id),
    onSuccess: (_data, on) =>
      toast.success(on ? "Listo: ya no espera respuesta" : "Vuelve a esperar respuesta"),
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: onChanged,
  })
  // Escribir a mano también es «Lo atiendo yo»: al enviar, el servidor pausa a Kairós aquí.
  const canWrite = chat.canReplyFreely
  // La propuesta va con la primera respuesta que sale; después, lo que se escriba ya no la lleva.
  const [proposal, setProposal] = useState(proposalId)
  const schema = z
    .object({
      body: z.string(),
      fileIds: z.array(z.string()).max(5, "Adjunta como máximo 5 archivos"),
    })
    .superRefine((value, ctx) => {
      if (!value.body.trim() && value.fileIds.length === 0)
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "Escribe la respuesta o adjunta un archivo",
        })
      const problem = replyTextProblem(value.body, chat.channel, chat.rules)
      if (problem) ctx.addIssue({ code: "custom", path: ["body"], message: problem })
    })
  const form = useAppForm({
    defaultValues: { body: draft, fileIds: [] as string[] },
    validators: { onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      const empty = { body: "", fileIds: [] as string[] }
      try {
        const sent = await sendChatReply(chat.id, {
          ...(value.body.trim() ? { body: value.body.trim() } : {}),
          ...(value.fileIds.length ? { fileIds: value.fileIds } : {}),
          ...(proposal ? { proposalId: proposal } : {}),
        })
        const notOut = sent.parts.filter((part) => part.status !== "enviado")
        if (notOut.length > 0)
          toast.warning(
            `No se sabe si salió ${notOut.map((part) => (part.kind === "texto" ? "el texto" : `«${part.filename ?? "un archivo"}»`)).join(", ")}: no se reintenta. Revísalo y di si salió.`,
          )
        else announceSent(sent.status, channel, value.fileIds.length)
        setProposal(null)
        formApi.reset(empty)
      } catch (error) {
        if (error instanceof ChatSendError) {
          // Lo que salió (o no se sabe si salió) no se vuelve a enviar: queda en el formulario solo
          // lo que no salió. El texto va primero y después cada archivo, en el orden elegido.
          const parts = error.parts
          const textPart = parts.find((part) => part.kind === "texto")
          const fileParts = parts.filter((part) => part.kind === "archivo")
          const somethingLeft = parts.some((part) => part.status !== "no_salio")
          if (error.outcome === "incierto" || somethingLeft) {
            const left = parts.length
              ? {
                  body: !textPart || textPart.status === "no_salio" ? value.body : "",
                  fileIds: value.fileIds.filter(
                    (_id, index) => !fileParts[index] || fileParts[index]?.status === "no_salio",
                  ),
                }
              : empty
            setProposal(null)
            formApi.reset(left)
            const pending = left.body.trim() || left.fileIds.length > 0
            const words = `${error.message}${pending ? " Lo que no salió quedó aquí para enviarlo de nuevo." : ""}`
            if (error.outcome === "incierto") toast.warning(words)
            else toast.error(words)
            return
          }
        }
        // No salió nada (o pasaron las 24 h): el texto queda para cambiarlo o enviarlo de otra forma.
        throw error
      } finally {
        onChanged()
      }
    },
  })
  const surface = useFormSurface(form)
  useEffect(() => {
    onDirtyChange?.(surface.isDirty)
  }, [surface.isDirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const retomar = useMutation({
    mutationFn: () => sendChatRetomar(chat.id),
    onSuccess: (sent) => announceSent(sent.status, channel),
    onError: (error) => {
      if (error instanceof ChatSendError && error.outcome === "incierto")
        toast.warning(error.message)
      else toast.error(submitErrorMessage(error))
    },
    onSettled: onChanged,
  })
  const openWhatsApp = useMutation({
    mutationFn: ({ clientId, contactId }: { clientId: string; contactId: string }) =>
      openChatWith(clientId, contactId),
    onSuccess: (opened) => onAside({ kind: "otro-chat", chatId: opened.id }),
    onError: (error) => {
      const outcome = openChatOutcome(error, isAdmin)
      if (outcome.kind === "decidir") {
        toast.info("Ese celular ya nos escribió: di primero de quién es")
        onAside({ kind: "otro-chat", chatId: outcome.chatId, decide: true })
        return
      }
      if (outcome.kind === "wa.me" && person?.phone) {
        if (outcome.message) toast.info(outcome.message)
        window.open(waMeHref(person.phone), "_blank", "noopener")
        return
      }
      toast.error(submitErrorMessage(error))
    },
  })
  // El correo y el celular de quien escribe, para seguir por otra vía fuera de las 24 h.
  const sale = useClientSale(chat.client?.id ?? "", Boolean(chat.client) && !chat.canReplyFreely)
  const person = sale.data?.contacts.find((row) => row.id && row.id === chat.contact?.id)
  const unsettled = chat.entries.filter((entry) => isUnsettled(entry, new Date())).length
  const attendedByMe = chat.attendedBy?.id === myUserId
  const settled = chat.state === "respondida" && Boolean(chat.settledAt)

  const content = (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {/* Sin cliente no se repite aquí: el subtítulo ya dice «sin cliente todavía». */}
        {chat.client ? (
          <ClientName clientId={chat.client.id} tab="historial">
            Ver la ficha de {chat.client.name}
          </ClientName>
        ) : null}
        {chat.client?.phase && chat.client.phase in CLIENT_PHASE_WORDS ? (
          <span className="text-muted-foreground">
            · {CLIENT_PHASE_WORDS[chat.client.phase as ClientPhase]}
          </span>
        ) : null}
        <ChatAppChange chatId={chat.id} app={chat.app} hasClient={Boolean(chat.client)} canChange={isAdmin} />
        {chat.attendedBy && !kairos ? (
          <span className="text-muted-foreground">
            {attendedByMe
              ? "· Lo atiendes tú"
              : `· Lo atiende ${chat.attendedBy.name.trim().split(/\s+/)[0]}`}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {!kairos && !attendedByMe ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={takeOver.isPending}
              onClick={() => takeOver.mutate(true)}
            >
              Lo atiendo yo
            </Button>
          ) : null}
          {chat.state === "te_toca" ? (
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
          {isAdmin && chat.client ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onAside({ kind: "mover" })}
            >
              Mover a otra clínica
            </Button>
          ) : null}
          {isAdmin && !chat.client && !chat.notClinicAt ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onAside({ kind: "decidir" })}
            >
              ¿De quién es?
            </Button>
          ) : null}
        </div>
      </div>

      {chat.client?.phase === "activo" ? (
        <p className="text-sm text-muted-foreground">
          Ya usa su app: si es una consulta de uso, la ayuda va por Soporte, dentro de su app.
        </p>
      ) : null}

      {chat.notClinicAt ? (
        <PageNotice
          tone="aviso"
          label="No es una clínica"
          action={
            isAdmin ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={undo.isPending}
                onClick={() => undo.mutate(chat.id)}
              >
                Deshacer
              </Button>
            ) : null
          }
        >
          Se marcó como «No es una clínica»: sus mensajes siguen llegando aquí, pero no esperan
          respuesta.
        </PageNotice>
      ) : null}

      {kairos ? (
        <PageNotice
          tone={kairos.kind === "paso" ? "alarma" : "aviso"}
          label={
            kairos.kind === "kairos"
              ? "Kairós atiende esta conversación"
              : kairos.kind === "paso"
                ? "Kairós se la pasó al equipo"
                : "Kairós está en pausa aquí"
          }
          action={
            kairos.kind === "kairos" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={takeOver.isPending}
                onClick={() => takeOver.mutate(true)}
              >
                Lo atiendo yo
              </Button>
            ) : kairos.canReturn ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={takeOver.isPending}
                onClick={() => takeOver.mutate(false)}
              >
                Devolver a Kairós
              </Button>
            ) : null
          }
        >
          {kairos.kind === "kairos"
            ? "Responde lo de las webs y los precios, y agenda presentaciones. Nunca ofrece descuentos. Si escribes tú, deja de responder aquí."
            : kairos.kind === "paso"
              ? `${kairos.why ? `${kairos.why}. ` : ""}Respóndele tú; Kairós no vuelve a escribir aquí hasta que lo devuelvas.`
              : kairos.words}
        </PageNotice>
      ) : null}

      <Messages chat={chat} onChanged={onChanged} />

      {isAdmin && chat.files.length > 0 ? <ChatFiles chat={chat} onChanged={onChanged} /> : null}

      {unsettled > 0 ? (
        <PageNotice tone="alarma" label="Antes de enviar otro">
          {unsettled === 1
            ? "Hay un mensaje del que no se sabe si salió. Revísalo arriba y di si salió antes de escribir otra vez."
            : `Hay ${unsettled} mensajes de los que no se sabe si salieron. Revísalos arriba antes de escribir otra vez.`}
        </PageNotice>
      ) : null}

      <section
        aria-labelledby={`chat-responder-${chat.id}`}
        className="flex flex-col gap-3 border-t pt-4"
      >
        <h3 id={`chat-responder-${chat.id}`} className="text-sm font-semibold">
          Responder por {channel}
        </h3>
        <p className="text-sm text-muted-foreground">{freeWindowWords(chat)}</p>
        {kairos?.kind === "kairos" ? (
          <p className="text-sm text-muted-foreground">
            Kairós está respondiendo aquí. Si envías tú, lo atiendes tú y Kairós deja de responder.
          </p>
        ) : null}
        {chat.canReplyFreely ? (
          <>
            <form.AppField name="body">
              {(field) => (
                <field.Control label="Respuesta" hideLabel description={replyHelpWords(chat)}>
                  {(control) => (
                    <ReplyEditor
                      control={control.props}
                      value={field.state.value}
                      onChange={field.handleChange}
                      channel={chat.channel}
                      rules={chat.rules}
                      improve={{ chatId: chat.id }}
                      appended={chat.replySignature}
                      autoFocus={layout === "drawer" && Boolean(draft)}
                      below={
                        chat.client ? (
                          <form.Field name="fileIds">
                            {(files) => (
                              <ReplyFiles
                                clientId={chat.client?.id ?? ""}
                                isAdmin={isAdmin}
                                rules={chat.rules}
                                channelWords={channel}
                                value={files.state.value}
                                onChange={files.handleChange}
                                error={
                                  files.state.meta.errors
                                    .map((issue) =>
                                      typeof issue === "string" ? issue : issue?.message,
                                    )
                                    .find(Boolean) ?? null
                                }
                              />
                            )}
                          </form.Field>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Para mandar archivos, primero di de quién es: los archivos salen de sus
                            Documentos.
                          </p>
                        )
                      }
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
            {proposal ? (
              <p className="text-xs text-muted-foreground">
                Va como el envío de la propuesta: queda enviada cuando salga. Por WhatsApp no va el
                PDF: si hace falta, envíalo por correo.
              </p>
            ) : null}
          </>
        ) : chat.channel === "whatsapp" ? (
          <div className="flex flex-col gap-2">
            <div>
              <SubmitButton
                type="button"
                pending={retomar.isPending}
                disabled={retomar.isPending}
                onClick={() => retomar.mutate()}
              >
                Retomar con la plantilla
              </SubmitButton>
            </div>
            <p className="text-xs text-muted-foreground">
              Sale la plantilla aprobada por WhatsApp, con tu nombre. Cuando responda, vuelve a
              poder escribirse con texto libre.
            </p>
          </div>
        ) : chat.client ? (
          <div className="flex flex-wrap gap-2">
            {person?.email ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  chat.client &&
                  onAside({
                    kind: "correo",
                    clientId: chat.client.id,
                    contactId: person.id ?? null,
                  })
                }
              >
                Escribir un correo
              </Button>
            ) : null}
            {person?.phone && person.id ? (
              <Button
                type="button"
                variant="outline"
                disabled={openWhatsApp.isPending}
                onClick={() =>
                  chat.client &&
                  person.id &&
                  openWhatsApp.mutate({ clientId: chat.client.id, contactId: person.id })
                }
              >
                Escribir por WhatsApp
              </Button>
            ) : null}
            {!person?.email && !person?.phone ? (
              <p className="text-sm text-muted-foreground">
                {sale.isPending
                  ? "Buscando su correo y su celular…"
                  : "No tenemos su correo ni su celular: agrégalos en las personas de la ficha."}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sin cliente no tenemos otra forma de escribirle: primero di de quién es.
          </p>
        )}
      </section>
    </div>
  )

  return layout === "pane" ? (
    <FormPanel
      {...surface}
      onClose={onClose}
      title={chatTitle(chat)}
      description={chatSubtitle(chat)}
      hideSubmit={!canWrite}
      submitLabel={`Enviar por ${channel}`}
      cancelLabel={common.actions.close}
      className="h-full"
    >
      {content}
    </FormPanel>
  ) : (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={chatTitle(chat)}
      description={chatSubtitle(chat)}
      hideSubmit={!canWrite}
      submitLabel={`Enviar por ${channel}`}
      cancelLabel={common.actions.close}
    >
      {content}
    </FormDrawer>
  )
}

/** Los mensajes por día: lo que escribió a la izquierda y lo nuestro a la derecha. */
function Messages({ chat, onChanged }: { chat: ChatDetail; onChanged: () => void }) {
  const days = entriesByDay(chat.entries)
  if (days.length === 0)
    return <p className="text-sm text-muted-foreground">Todavía no hay mensajes.</p>
  return (
    <section aria-label="Mensajes" className="flex flex-col gap-4">
      {days.map((day) => (
        <div key={day.key} className="flex flex-col gap-2">
          <h3 className="text-center text-xs font-medium text-muted-foreground">{day.heading}</h3>
          <ol className="flex flex-col gap-2">
            {day.entries.map((entry) =>
              entry.kind === "entro" ? (
                <Inbound key={entry.id} entry={entry} />
              ) : (
                <Outbound key={entry.id} entry={entry} onChanged={onChanged} />
              ),
            )}
          </ol>
        </div>
      ))}
    </section>
  )
}

function Inbound({ entry }: { entry: Extract<ChatEntry, { kind: "entro" }> }) {
  return (
    <li className="mr-8 flex flex-col gap-1 self-start rounded-lg rounded-tl-none bg-muted p-3 text-sm sm:mr-16">
      {entry.body ? (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.body}</p>
      ) : null}
      {entry.media.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Paperclip aria-hidden className="size-3.5" />
          <span className="[overflow-wrap:anywhere]">
            {entry.media.map((item) => item.filename).join(" · ")}
          </span>
        </p>
      ) : entry.mediaCount > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Paperclip aria-hidden className="size-3.5" />
          {entry.mediaCount === 1 ? "1 archivo" : `${entry.mediaCount} archivos`} (los ve
          Administración)
        </p>
      ) : null}
      <span className="text-xs text-muted-foreground">{supportTime(entry.at)}</span>
    </li>
  )
}

function Outbound({
  entry,
  onChanged,
}: {
  entry: Extract<ChatEntry, { kind: "salio" }>
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
  const unsettled = isUnsettled(entry, new Date())
  return (
    <li className="ml-8 flex flex-col gap-1.5 self-end rounded-lg rounded-tr-none border bg-card p-3 text-sm sm:ml-16">
      {entry.template ? (
        <p className="text-xs font-medium text-muted-foreground">Plantilla para retomar</p>
      ) : null}
      {entry.files.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
          <Paperclip aria-hidden className="size-3.5 text-muted-foreground" />
          {entry.files.map((file) => file.filename).join(" · ")}
        </p>
      ) : (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.body}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {entry.byKairos ? <AgentMark size="sm" className="size-4" /> : null}
        <span>{sentLineWords(entry)}</span>
      </div>
      {entry.status === "enviado" && entry.failedAt ? (
        <p className="text-xs text-destructive">
          WhatsApp dijo que no le llegó{entry.failedWhy ? `: ${entry.failedWhy}` : ""}. Vuelve a «Te
          toca».
        </p>
      ) : null}
      {entry.byKairos && entry.basis.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">En qué se basó:</span> {entry.basis.join(" · ")}
        </p>
      ) : null}
      {unsettled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">¿Salió?</span>
          <Button
            type="button"
            size="sm"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate("salio")}
          >
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

/** Los archivos que mandó, ya en Documentos; solo Administración marca la carga. */
function ChatFiles({ chat, onChanged }: { chat: ChatDetail; onChanged: () => void }) {
  const carga = useMarkCarga(chat.client?.id ?? null, onChanged)
  return (
    <section aria-labelledby="chat-archivos" className="flex flex-col gap-2">
      <h3 id="chat-archivos" className="text-sm font-semibold">
        Archivos
      </h3>
      <ul className="flex flex-col gap-2">
        {chat.files.map((file) => {
          const state = chatFileState(file)
          return (
            <li
              key={file.fileId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 text-sm"
            >
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                {chatFileTypeWords(file.contentType, file.filename)}
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-medium [overflow-wrap:anywhere]">{file.filename}</p>
                <p className="text-xs text-muted-foreground">{state.words}</p>
              </div>
              {state.canMark ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
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
          )
        })}
      </ul>
      {carga.dialog}
    </section>
  )
}
