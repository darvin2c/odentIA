/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db"
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js"
export { compileAgentGraph } from "./graph.js"
export { formatForChannel } from "./channel-format.js"
export {
  createConfiguredChatModel,
  describeProviderProblem,
  isProviderConfigError,
  LLM_CATALOG,
  LlmConfigError,
  llmModelName,
  type LlmProvider,
  type LlmSpec,
  type PlatformLlm,
  type PlatformLlmEnv,
  platformLlmFromEnv,
  type ProviderAccount,
  resolveLlmSpec,
} from "./llm.js"
export * from "./decision/index.js"
export { embedderFromEnv, type EmbeddingsEnv, FAKE_EMBEDDINGS_MODEL, fakeEmbedder, openAiEmbedder } from "./embeddings.js"
export { type AdminModelDeps, ALREADY_TOLD_MIN, asAdminDecider, createAdminDecisionModel, createAlreadyTold } from "./admin.js"
export { runShadowTriage } from "./decision/shadow.js"
export {
  type AgentRuntime,
  consumeAgentRun,
  processAgentRun,
  EMPTY_SANDBOX_STATE,
  type LessonPreview,
  type SandboxResult,
  type SandboxTurn,
  previewLesson,
  simulateAgentSandbox,
  simulateAgentTurn,
  type SimulationResult,
} from "./run.js"
export type { AgentSandboxState } from "./tools.js"
export { demoExtraction, demoSegment, type DictationExtraction, type DictationPending, extractDictation, groundSource } from "./dictation.js"
