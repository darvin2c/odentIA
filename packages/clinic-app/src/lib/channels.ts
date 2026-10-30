import { internationalText } from "@odentia/ui-patterns"
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

/**
 * Cómo se ve la cuenta por la que escribe una persona: en WhatsApp, su número
 * con el formato de toda la aplicación (`+51 987 654 100`); en otro canal, el
 * nombre que da el canal o «Cuenta de Telegram». Nunca «wa:» ni un identificador
 * técnico.
 */
export function identityText(identity: {
  channel: string
  externalUserId: string
  displayName: string | null
}): string {
  // Quien oculta su número tiene por dirección su BSUID (`wa:PE.1349…`), que no es un teléfono (ADR 0110).
  if (identity.channel === "whatsapp" && /^wa:\+?\d+$/.test(identity.externalUserId)) {
    return internationalText(`+${identity.externalUserId.replace(/\D/g, "")}`)
  }
  return identity.displayName || `Cuenta de ${channelLabel(identity.channel)}`
}
