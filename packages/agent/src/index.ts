/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db";
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js";
export { compileAgentGraph, createChatModel, type AgentRunCtx } from "./graph.js";
export { consumeAgentRun, processAgentRun, type AgentRuntime } from "./run.js";
export { makeAgentTools, performHandoff, type AgentToolCtx } from "./tools.js";
