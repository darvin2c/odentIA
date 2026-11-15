/**
 * «Escribir por WhatsApp» a una persona del cliente. Con el número de Sallca
 * configurado (`GET /api/admin/chats/config`), abre su conversación en la
 * administración (`POST /api/admin/chats/open`, creada si no existe) y sale
 * desde ese número. Sin configurar, o para un celular que no es de ninguna
 * persona del cliente, sigue abriendo wa.me como antes: nada se rompe. Si ese
 * celular ya escribió sin decir de quién es (409 `CHAT_UNASSIGNED`: el celular
 * solo no la liga), Administración lo dice ahí mismo en «¿De quién es?»; Soporte,
 * que no decide de quién es ni ve la venta, sigue por wa.me como antes.
 */
import { toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useIsAdmin } from "../../lib/session"
import { chatKey, openChatOutcome, openChatWith, useChatsConfig, waMeHref } from "./chat-api"
import { ChatDrawer } from "./chat-drawer"

export { waMeHref }

const linkClass =
  "underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"

/** Si «Escribir por WhatsApp» sale desde la administración o abre wa.me. */
export const writesThroughChat = (configured: boolean | undefined, contactId: string | null) =>
  configured === true && Boolean(contactId)

export function WhatsAppWrite({
  clientId,
  contactId,
  phone,
  fallbackLabel,
}: {
  clientId: string
  /** La persona del cliente con ese celular; sin ella, wa.me. */
  contactId: string | null
  phone: string
  /** Lo que dice el enlace a wa.me (sin el número de Sallca). */
  fallbackLabel: string
}) {
  const queryClient = useQueryClient()
  const config = useChatsConfig()
  const isAdmin = useIsAdmin()
  const [opened, setOpened] = useState<{ chatId: string; decide: boolean } | null>(null)
  const open = useMutation({
    mutationFn: () => openChatWith(clientId, contactId ?? ""),
    onSuccess: (chat) => {
      queryClient.setQueryData(chatKey(chat.id), chat)
      setOpened({ chatId: chat.id, decide: false })
    },
    onError: (error) => {
      const outcome = openChatOutcome(error, isAdmin)
      if (outcome.kind === "decidir") {
        toast.info("Ese celular ya nos escribió: di primero de quién es")
        setOpened({ chatId: outcome.chatId, decide: true })
        return
      }
      if (outcome.kind === "wa.me") {
        if (outcome.message) toast.info(outcome.message)
        window.open(waMeHref(phone), "_blank", "noopener")
        return
      }
      toast.error(submitErrorMessage(error))
    },
  })
  if (!writesThroughChat(config.data?.whatsapp, contactId))
    return (
      <a className={linkClass} href={waMeHref(phone)} target="_blank" rel="noreferrer">
        {fallbackLabel}
      </a>
    )
  return (
    <>
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        <span>{phone}</span>
        <button
          type="button"
          className={linkClass}
          disabled={open.isPending}
          onClick={() => open.mutate()}
        >
          {open.isPending ? "Abriendo…" : "Escribir por WhatsApp"}
        </button>
      </span>
      {opened ? (
        <ChatDrawer
          chatId={opened.chatId}
          decide={opened.decide}
          open
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  )
}
