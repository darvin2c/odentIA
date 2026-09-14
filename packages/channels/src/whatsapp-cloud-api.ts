import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  NormalizedStatus,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js";

export interface WhatsAppTemplateRef {
  name: string;
  language: string;
}

export interface WhatsAppCloudConfig {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
  templates: WhatsAppTemplateRef[];
}

const GRAPH_VERSION = "v21.0";

function getConfig(config: Record<string, unknown>): WhatsAppCloudConfig {
  const pick = (k: string): string => {
    const v = config[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`WhatsApp: falta ${k} en la configuración de la conexión`);
    }
    return v;
  };
  const rawTemplates = config["templates"];
  const templates: WhatsAppTemplateRef[] = [];
  if (Array.isArray(rawTemplates)) {
    for (const t of rawTemplates) {
      if (
        t &&
        typeof t === "object" &&
        "name" in t &&
        typeof t.name === "string" &&
        "language" in t &&
        typeof t.language === "string"
      ) {
        templates.push({ name: t.name, language: t.language });
      }
    }
  }
  return {
    phoneNumberId: pick("phoneNumberId"),
    wabaId: pick("wabaId"),
    accessToken: pick("accessToken"),
    appSecret: pick("appSecret"),
    templates,
  };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

interface WaMedia {
  id: string;
  mime_type?: string;
  caption?: string;
}

interface WaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: WaMedia;
  document?: WaMedia;
  audio?: WaMedia;
}

interface WaStatus {
  id: string;
  status: string;
  timestamp: string;
}

interface WaValue {
  messaging_product?: string;
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
}

function displayNameOf(value: WaValue, from: string): string | undefined {
  return value.contacts?.find((c) => c.wa_id === from)?.profile?.name;
}

function messageToNormalized(m: WaMessage, displayName: string | undefined): NormalizedInbound | null {
  const base = {
    externalEventId: m.id,
    externalMessageId: m.id,
    externalThreadId: `wa:${m.from}`,
    senderExternalId: `wa:${m.from}`,
    sentAt: new Date(Number(m.timestamp) * 1000).toISOString(),
  };
  const withName = displayName ? { senderDisplayName: displayName } : {};
  if (m.type === "text" && typeof m.text?.body === "string") {
    return { ...base, ...withName, content: { type: "text", text: m.text.body } };
  }
  const media: WaMedia | undefined =
    m.type === "image" ? m.image : m.type === "document" ? m.document : m.type === "audio" ? m.audio : undefined;
  if (media) {
    const withCaption = typeof media.caption === "string" ? { caption: media.caption } : {};
    return {
      ...base,
      ...withName,
      content: {
        type: "media",
        mediaExternalId: media.id,
        mimeType: media.mime_type ?? "application/octet-stream",
        ...withCaption,
      },
    };
  }
  // Tipos no soportados (reaction, sticker, location…): se ignoran.
  return null;
}

function statusToNormalized(s: WaStatus): NormalizedStatus | null {
  const map: Record<string, NormalizedStatus["status"]> = {
    delivered: "delivered",
    read: "read",
    failed: "failed",
  };
  const status = map[s.status];
  // 'sent' y otros no tienen equivalente local.
  if (!status) return null;
  return { externalMessageId: s.id, status };
}

async function graphFetch(
  cfg: WhatsAppCloudConfig,
  path: string,
  init: { method?: string; body?: unknown },
  deps: ChannelAdapterDeps,
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

function graphError(status: number, json: unknown): string {
  if (json && typeof json === "object" && "error" in json && json.error && typeof json.error === "object") {
    const err = json.error;
    const message = "message" in err && typeof err.message === "string" ? err.message : null;
    if (message) return message;
  }
  return `HTTP ${status}`;
}

function sentMessageId(json: unknown): string | null {
  if (!json || typeof json !== "object" || !("messages" in json) || !Array.isArray(json.messages)) return null;
  const first = json.messages[0];
  if (!first || typeof first !== "object" || !("id" in first)) return null;
  return typeof first.id === "string" ? first.id : null;
}

function mediaInfo(json: unknown): { url: string; mimeType: string } | null {
  if (!json || typeof json !== "object" || !("url" in json) || typeof json.url !== "string") return null;
  const mimeType =
    "mime_type" in json && typeof json.mime_type === "string" ? json.mime_type : "application/octet-stream";
  return { url: json.url, mimeType };
}

function connectionInfo(json: unknown): { id?: string; displayName?: string } {
  if (!json || typeof json !== "object") return {};
  const id = "id" in json && typeof json.id === "string" ? json.id : undefined;
  const verified = "verified_name" in json && typeof json.verified_name === "string" ? json.verified_name : undefined;
  const phone =
    "display_phone_number" in json && typeof json.display_phone_number === "string"
      ? json.display_phone_number
      : undefined;
  return { ...(id ? { id } : {}), ...(verified ?? phone ? { displayName: verified ?? phone } : {}) };
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
};

export const whatsappCloudApiAdapter: ChannelAdapter = {
  provider: "whatsapp_cloud_api",
  capabilities: { templates: true, media: true, interactive: true, readReceipts: true, edit: false },

  verifyWebhook({ headers, rawBody, config }) {
    const appSecret = config["appSecret"];
    if (typeof appSecret !== "string" || appSecret.length === 0) return false;
    const given = header(headers, "x-hub-signature-256");
    if (!given || !given.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
    if (expected.length !== given.length) return false;
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
  },

  parseWebhook({ rawBody }): WebhookParseResult {
    const empty: WebhookParseResult = { messages: [], statuses: [] };
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return empty;
    }
    if (!body || typeof body !== "object" || !("entry" in body) || !Array.isArray(body.entry)) return empty;
    const messages: NormalizedInbound[] = [];
    const statuses: NormalizedStatus[] = [];
    for (const entry of body.entry) {
      if (!entry || typeof entry !== "object" || !("changes" in entry) || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        if (!change || typeof change !== "object" || !("value" in change)) continue;
        const value = change.value as WaValue;
        if (!value || typeof value !== "object") continue;
        for (const m of value.messages ?? []) {
          const n = messageToNormalized(m, displayNameOf(value, m.from));
          if (n) messages.push(n);
        }
        for (const s of value.statuses ?? []) {
          const n = statusToNormalized(s);
          if (n) statuses.push(n);
        }
      }
    }
    return { messages, statuses };
  },

  async sendMessage(config, msg: OutboundMessage, deps) {
    const cfg = getConfig(config);
    // `to` es el externalThreadId del parse (`wa:<phone>`).
    const to = msg.to.startsWith("wa:") ? msg.to.slice("wa:".length) : msg.to;
    const body =
      msg.kind.type === "text"
        ? { messaging_product: "whatsapp", to, type: "text", text: { body: msg.kind.text, preview_url: false } }
        : {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: msg.kind.name,
              language: { code: msg.kind.language },
              components: [{ type: "body", parameters: msg.kind.params.map((text) => ({ type: "text", text })) }],
            },
          };
    const { status, json } = await graphFetch(cfg, `${cfg.phoneNumberId}/messages`, { method: "POST", body }, deps);
    const id = sentMessageId(json);
    if (status >= 400 || !id) {
      throw new Error(`WhatsApp send falló: ${status} ${graphError(status, json)}`);
    }
    return { externalId: id };
  },

  async fetchMedia(config, mediaExternalId, deps) {
    const cfg = getConfig(config);
    const { status, json } = await graphFetch(cfg, mediaExternalId, {}, deps);
    const info = mediaInfo(json);
    if (status >= 400 || !info) {
      throw new Error(`WhatsApp media lookup falló: ${status}`);
    }
    const dl = await deps.fetch(info.url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
    if (!dl.ok) throw new Error(`WhatsApp descarga de media falló: ${dl.status}`);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const ext = EXT_BY_MIME[info.mimeType] ?? "bin";
    return { bytes, mimeType: info.mimeType, filename: `${mediaExternalId}.${ext}` };
  },

  async validateConnection(config, deps) {
    const cfg = getConfig(config);
    const { status, json } = await graphFetch(
      cfg,
      `${cfg.phoneNumberId}?fields=display_phone_number,verified_name`,
      {},
      deps,
    );
    if (status >= 400) {
      throw new Error("WhatsApp validate falló: token o phone_number_id inválido");
    }
    const info = connectionInfo(json);
    return {
      externalId: info.id ?? cfg.phoneNumberId,
      displayName: info.displayName ?? cfg.phoneNumberId,
    };
  },
};
