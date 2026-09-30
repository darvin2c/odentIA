import { Globe, Instagram, Mail, MessageCircle, Send, type LucideIcon } from "lucide-react"

const channels: Record<string, { label: string; icon: LucideIcon }> = {
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  telegram: { label: "Telegram", icon: Send },
  messenger: { label: "Messenger", icon: MessageCircle },
  instagram: { label: "Instagram", icon: Instagram },
  email: { label: "Correo", icon: Mail },
  gmail: { label: "Gmail", icon: Mail },
  microsoft365: { label: "Microsoft 365", icon: Mail },
  webchat: { label: "Chat web", icon: Globe },
  web_chat: { label: "Chat web", icon: Globe },
}

/** El canal pertenece al núcleo; no se deduce de su proveedor. */
export function channelLabel(channel: string): string {
  return channels[channel]?.label ?? channel
}

export function channelIcon(channel: string): LucideIcon {
  return channels[channel]?.icon ?? MessageCircle
}
