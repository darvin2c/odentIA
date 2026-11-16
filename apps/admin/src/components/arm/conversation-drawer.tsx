/**
 * Una conversación de la Bandeja abierta en un cajón (ADR 0196): la misma que se ve en `/inbox`, para
 * abrirla desde el historial, la ficha o Hoy sin salir de donde se está. Un chat se abre por su id;
 * un correo, por cualquiera de los correos de su hilo (el servidor arma el hilo entero).
 */
import { ChatDrawer } from "./chat-drawer"
import { EmailDrawer } from "./email-drawer"

export type ConversationTarget = { kind: "chat"; chatId: string } | { kind: "correo"; emailId: string }

export function ConversationDrawer({
  target,
  open,
  onClose,
}: {
  target: ConversationTarget | null
  open: boolean
  onClose: () => void
}) {
  if (!open || !target) return null
  if (target.kind === "chat") return <ChatDrawer open chatId={target.chatId} onClose={onClose} />
  return <EmailDrawer open emailId={target.emailId} onClose={onClose} />
}
