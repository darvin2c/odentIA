import { getRouteApi } from "@tanstack/react-router";

const orgRouteApi = getRouteApi("/_org");

/** Tipos mínimos del CRM para la UI (la API es la fuente de verdad). */
export interface ConversationPreview {
  body: string | null;
  direction: string;
  senderKind: string;
  createdAt: string;
}

export interface ConversationListItem {
  id: string;
  status: string;
  agentStatus: string;
  unreadCount: number;
  assignedUserId: string | null;
  lastMessageAt: string | null;
  contact: { id: string; displayName: string };
  connection: { id: string; channel: string; provider: string; displayName: string };
  preview: ConversationPreview | null;
}

export interface ChatMessage {
  id: string;
  direction: string;
  senderKind: string;
  contentType: string;
  body: string | null;
  attachments: { objectKey: string; mimeType: string; filename: string; size: number }[];
  externalId: string | null;
  status: string;
  error: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateParams: string[] | null;
  createdAt: string;
}

export interface ConversationDetail {
  conversation: {
    id: string;
    status: string;
    agentStatus: string;
    unreadCount: number;
    assignedUserId: string | null;
    lastMessageAt: string | null;
  };
  contact: { id: string; displayName: string };
  connection: {
    id: string;
    channel: string;
    provider: string;
    displayName: string;
    capabilities: { templates: boolean; media: boolean; interactive: boolean; readReceipts: boolean; edit: boolean } | null;
  };
  messages: ChatMessage[];
  messagesCursor: string | null;
}

export interface TaskItem {
  id: string;
  title: string;
  contactId: string | null;
  conversationId: string | null;
  assigneeUserId: string | null;
  dueAt: string | null;
  status: string;
  createdBy: string;
}

/** Rol del usuario en la org del host: owner/admin pueden escribir. */
export function useCanWrite(): boolean {
  const { org, session } = orgRouteApi.useRouteContext();
  const me = org.members.find((m) => m.userId === session.userId);
  return me?.role === "owner" || me?.role === "admin";
}

export function useMyUserId(): string {
  const { session } = orgRouteApi.useRouteContext();
  return session.userId;
}

/** Hace cuánto (es-PE, corto): "hace 5 min", "ayer", "12/03". */
export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return "";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return new Date(iso).toLocaleDateString("es-PE", { day: "numeric", month: "numeric" });
}

export interface ContactListItem {
  id: string;
  displayName: string;
  tags: string[];
  stageId: string | null;
  assignedUserId: string | null;
  lastInteractionAt: string | null;
  channels: string[];
}

export interface ContactFull {
  contact: ContactListItem & {
    notes: string | null;
    customFields: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
  identities: { id: string; channel: string; externalUserId: string; displayName: string | null }[];
  openTasks: { id: string; title: string; dueAt: string | null; assigneeUserId: string | null }[];
  conversations: { id: string; status: string; lastMessageAt: string | null }[];
}

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  kind: string;
}

export interface Pipeline {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Stage[];
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  position: number;
}

export interface ConnectionItem {
  id: string;
  channel: string;
  provider: string;
  displayName: string;
  externalId: string | null;
  status: string;
  capabilities: { templates: boolean; media: boolean; interactive: boolean; readReceipts: boolean; edit: boolean } | null;
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentConfig {
  organizationId: string;
  enabled: boolean;
  model: string | null;
  systemPrompt: string;
  handoffKeywords: string[];
  maxTurns: number;
}
