/**
 * «Escribir por WhatsApp» a una persona del cliente. Con el número de Sallca
 * configurado (`GET /api/admin/chats/config`), abre su conversación en la
 * administración (`POST /api/admin/chats/open`, creada si no existe) y sale
 * desde ese número. Sin configurar, o para un celular que no es de ninguna
 * persona del cliente, sigue abriendo wa.me como antes: nada se rompe.
 */
import { toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { chatKey, openChatWith, useChatsConfig } from "./chat-api"
import { ChatDrawer } from "./chat-drawer"

const linkClass =
  "underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"

/** El enlace de siempre: abre WhatsApp en otra pestaña con ese número. */
export const waMeHref = (phone: string) => `https://wa.me/${phone.replace(/^\+/, "")}`

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
  const [chatId, setChatId] = useState<string | null>(null)
  const open = useMutation({
    mutationFn: () => openChatWith(clientId, contactId ?? ""),
    onSuccess: (chat) => {
      queryClient.setQueryData(chatKey(chat.id), chat)
      setChatId(chat.id)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
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
      {chatId ? <ChatDrawer chatId={chatId} open onClose={() => setChatId(null)} /> : null}
    </>
  )
}
