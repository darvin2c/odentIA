// Protocolo puro del framework de canales: sin db, sin S3, sin env.
// Los adaptadores de proveedor (paso 2) implementan ChannelAdapter.

export type ChannelProvider = "whatsapp_cloud_api" | "telegram_bot_api"

export interface ChannelCapabilities {
  templates: boolean
  media: boolean
  interactive: boolean
  readReceipts: boolean
  edit: boolean
}

export type InboundContent =
  | { type: "text"; text: string }
  | { type: "media"; mediaExternalId: string; mimeType: string; caption?: string }

export interface NormalizedInbound {
  externalEventId: string
  externalMessageId: string
  externalThreadId: string
  senderExternalId: string
  senderDisplayName?: string
  content: InboundContent
  /** ISO-8601 del instante de envío según el proveedor. */
  sentAt: string
}

export interface NormalizedStatus {
  externalMessageId: string
  status: "delivered" | "read" | "failed"
}

export interface WebhookParseResult {
  messages: NormalizedInbound[]
  statuses: NormalizedStatus[]
}

export interface OutboundMessage {
  to: string
  kind:
    | { type: "text"; text: string }
    | { type: "template"; name: string; language: string; params: string[] }
}

export interface ChannelAdapterDeps {
  fetch: typeof fetch
}

export interface ChannelAdapter {
  provider: ChannelProvider
  capabilities: ChannelCapabilities
  verifyWebhook(input: {
    headers: Record<string, string>
    rawBody: string
    config: Record<string, unknown>
    webhookSecret: string
  }): boolean
  parseWebhook(input: {
    headers: Record<string, string>
    rawBody: string
    config: Record<string, unknown>
  }): WebhookParseResult
  sendMessage(
    config: Record<string, unknown>,
    msg: OutboundMessage,
    deps: ChannelAdapterDeps,
  ): Promise<{ externalId: string }>
  fetchMedia?(
    config: Record<string, unknown>,
    mediaExternalId: string,
    deps: ChannelAdapterDeps,
  ): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }>
  validateConnection(
    config: Record<string, unknown>,
    deps: ChannelAdapterDeps,
  ): Promise<{ externalId: string; displayName: string }>
}
