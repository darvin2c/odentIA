/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db"
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js"
export { compileAgentGraph, createChatModel } from "./graph.js"
export { type AgentRuntime, consumeAgentRun, processAgentRun } from "./run.js"
export { type AgentToolCtx, makeAgentTools, performHandoff } from "./tools.js"
