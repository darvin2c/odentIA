/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db"
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js"
export { compileAgentGraph } from "./graph.js"
export { createConfiguredChatModel, providerOf, type LlmCredentials } from "./llm.js"
export { type AgentRuntime, consumeAgentRun, processAgentRun, simulateAgentTurn, type SimulationResult } from "./run.js"
