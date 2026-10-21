/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db"
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js"
export { compileAgentGraph } from "./graph.js"
export { formatForChannel } from "./channel-format.js"
export { AI_PRICES, type AiUse, costMicrosOf, meterAiUse, reportAiUse, reportReplyUse, summarizeAiUses, takeAiUsage, withAiMeter } from "./ai-usage.js"
export {
  createConfiguredChatModel,
  describeProviderProblem,
  fakeModelStartProblem,
  isProviderConfigError,
  AGENT_MODEL,
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
export {
  type AgentModelStatus,
  createModelChecker,
  MODEL_CHECK_TTL_MS,
  type ModelChecker,
  type ModelCheckResult,
  type ModelProbe,
} from "./model-check.js"
export * from "./decision/index.js"
export { embedderFromEnv, type EmbeddingsEnv, FAKE_EMBEDDINGS_MODEL, fakeEmbedder, openAiEmbedder } from "./embeddings.js"
export { type AdminModelDeps, ALREADY_TOLD_MIN, asAdminDecider, createAdminDecisionModel, createAlreadyTold, createRuleConflictModel } from "./admin.js"
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
export {
  type ArgosAskResult,
  type ArgosClosest,
  type ArgosDeps,
  type ArgosPlan,
  type ArgosRoute,
  type ArgosShown,
  type ArgosTable,
  ARGOS_ROUTE_QUESTION,
  argosMessages,
  askArgos,
  demoArgosPlan,
  routeArgos,
  routeArgosQuestion,
  routeByWords,
  showArgosAnswer,
  writeArgosPlan,
} from "./argos.js"
export { demoExtraction, demoSegment, type DictationExtraction, type DictationPending, extractDictation, groundSource } from "./dictation.js"
