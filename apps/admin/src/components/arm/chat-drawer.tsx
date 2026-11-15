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
 */
import { Badge, Button, toast } from "@odentia/ui"
import {
  common,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageNotice,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { useIsAdmin } from "../../lib/session"
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
  openChatOutcome,
  openChatWith,
  replyHelpWords,
  sendChatReply,
  sendChatRetomar,
  sentLineWords,
  useChat,
  waMeHref,
} from "./chat-api"
import { ChatOwnerDrawer, useNotClinic } from "./chat-owner-drawer"
import { useMarkCarga } from "./client-files-tab"
import { ClientName, invalidateArm } from "./hoy-links"
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
}

export function ChatDrawer(props: ChatDrawerProps) {
  if (!props.open) return null
  return <ChatSurface key={props.chatId} {...props} />
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
  if (aside.kind === "correo")
    return (
      <WriteDrawer
        open
        clientId={aside.clientId}
        channel="correo"
        contactId={aside.contactId}
        onClose={() => setAside({ kind: "ninguno" })}
      />
    )
  if (aside.kind === "mover" || aside.kind === "decidir")
    return (
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
    )
  return (
    <Conversation
      chat={data}
      draft={draft}
      proposalId={proposalId}
      onClose={onClose}
      onAside={setAside}
      onChanged={() => refresh(data.client?.id)}
    />
  )
}

const lastInbound = (chat: ChatDetail) =>
  [...chat.entries].reverse().find((entry) => entry.kind === "entro") as
    | Extract<ChatEntry, { kind: "entro" }>
    | undefined

const replySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Escribe la respuesta")
    .max(4000, "Usa como máximo 4000 caracteres"),
  adminOnly: z.boolean(),
})

/** El resultado de un envío dicho en un aviso: salió, no salió o no se sabe. */
function announceSent(status: string, channel: string) {
  if (status === "enviado") toast.success(`Salió por ${channel}`)
  else toast.warning(`No se sabe si salió por ${channel}: no se reintenta. Revísalo y di si salió.`)
}

function Conversation({
  chat,
  draft,
  proposalId,
  onClose,
  onAside,
  onChanged,
}: {
  chat: ChatDetail
  draft: string
  proposalId: string | null
  onClose: () => void
  onAside: (aside: Aside) => void
  onChanged: () => void
}) {
  const isAdmin = useIsAdmin()
  const channel = CHAT_CHANNEL_WORDS[chat.channel]
  const { undo } = useNotClinic()
  // «Solo administración» solo tiene sentido si Soporte ve la conversación (clínica con su app).
  const canHide = isAdmin && Boolean(chat.client?.hasAccount)
  // La propuesta va con la primera respuesta que sale; después, lo que se escriba ya no la lleva.
  const [proposal, setProposal] = useState(proposalId)
  const form = useAppForm({
    defaultValues: { body: draft, adminOnly: false },
    validators: { onSubmit: replySchema },
    onSubmit: async ({ value, formApi }) => {
      const empty = { body: "", adminOnly: false }
      try {
        const sent = await sendChatReply(chat.id, {
          body: value.body.trim(),
          ...(canHide ? { adminOnly: value.adminOnly } : {}),
          ...(proposal ? { proposalId: proposal } : {}),
        })
        announceSent(sent.status, channel)
        setProposal(null)
        formApi.reset(empty)
      } catch (error) {
        if (error instanceof ChatSendError && error.outcome === "incierto") {
          // Quedó guardado como «No se sabe si salió»: no se vuelve a enviar.
          setProposal(null)
          formApi.reset(empty)
          toast.warning(error.message)
          return
        }
        // No salió (o pasaron las 24 h): el texto queda para cambiarlo o enviarlo de otra forma.
        throw error
      } finally {
        onChanged()
      }
    },
  })
  const surface = useFormSurface(form)
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

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={chatTitle(chat)}
      description={chatSubtitle(chat)}
      hideSubmit={!chat.canReplyFreely}
      submitLabel={`Enviar por ${channel}`}
      cancelLabel={common.actions.close}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {chat.client ? (
            <ClientName clientId={chat.client.id} tab="historial">
              Ver la ficha de {chat.client.name}
            </ClientName>
          ) : (
            <span className="text-muted-foreground">Sin cliente todavía</span>
          )}
          {isAdmin && chat.client ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
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
              className="ml-auto"
              onClick={() => onAside({ kind: "decidir" })}
            >
              ¿De quién es?
            </Button>
          ) : null}
        </div>

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
            Se marcó como «No es una clínica»: sus mensajes siguen llegando aquí, pero no vuelven a
            Hoy.
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

        <section aria-labelledby="chat-responder" className="flex flex-col gap-3 border-t pt-4">
          <h3 id="chat-responder" className="text-sm font-semibold">
            Responder
          </h3>
          <p className="text-sm text-muted-foreground">{freeWindowWords(chat)}</p>
          {chat.canReplyFreely ? (
            <>
              <form.AppField name="body">
                {(field) => (
                  <field.TextareaField
                    id="chat-respuesta"
                    label="Respuesta"
                    description={replyHelpWords(chat)}
                    rows={5}
                    maxLength={4000}
                  />
                )}
              </form.AppField>
              {proposal ? (
                <p className="text-xs text-muted-foreground">
                  Va como el envío de la propuesta: queda enviada cuando salga. Por WhatsApp no va
                  el PDF: si hace falta, envíalo por correo.
                </p>
              ) : null}
              {canHide ? (
                <form.AppField name="adminOnly">
                  {(field) => (
                    <field.CheckboxField
                      id="chat-solo-admin"
                      label="Solo administración"
                      description="Soporte ve esta conversación; lo que marques así, no (por ejemplo, lo de cobros)."
                    />
                  )}
                </form.AppField>
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
                    : "No tenemos su correo ni su celular: agrégalos en Contactos de la ficha."}
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
                <Outbound
                  key={entry.id}
                  entry={entry}
                  // En una venta todo es solo de Administración: decirlo solo donde Soporte también mira.
                  marked={entry.adminOnly && Boolean(chat.client?.hasAccount)}
                  onChanged={onChanged}
                />
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
  marked,
  onChanged,
}: {
  entry: Extract<ChatEntry, { kind: "salio" }>
  marked: boolean
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
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.body}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{sentLineWords(entry)}</span>
        {marked ? <Badge variant="outline">Solo administración</Badge> : null}
      </div>
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
