/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db"
export {
  type AdminModelDeps,
  ALREADY_TOLD_MIN,
  asAdminDecider,
  createAdminDecisionModel,
  createAlreadyTold,
  createRuleConflictModel,
} from "./admin.js"
export {
  AI_PRICES,
  type AiUse,
  costMicrosOf,
  meterAiUse,
  reportAiUse,
  reportReplyUse,
  summarizeAiUses,
  takeAiUsage,
  withAiMeter,
} from "./ai-usage.js"
export {
  ARGOS_MAX_TURNS,
  type ArgosAskResult,
  type ArgosClosest,
  type ArgosDeps,
  type ArgosPlan,
  type ArgosRerun,
  type ArgosRoute,
  type ArgosShown,
  type ArgosTable,
  argosMessages,
  argosRouteQuestion,
  askArgos,
  demoArgosPlan,
  rerunArgos,
  routeArgos,
  routeArgosQuestion,
  routeByWords,
  showArgosAnswer,
} from "./argos.js"
export { formatForChannel } from "./channel-format.js"
export * from "./decision/index.js"
export {
  type DecisionKeyProblem,
  reportDecisionOutage,
  watchDecisionKey,
} from "./decision/outage.js"
export { runShadowTriage } from "./decision/shadow.js"
export {
  askDictationModel,
  type DictationAsk,
  type DictationExtraction,
  type DictationPending,
  type DictationProfile,
  groundSource,
} from "./dictation.js"
export {
  type EmbeddingsEnv,
  embedderFromEnv,
  FAKE_EMBEDDINGS_MODEL,
  fakeEmbedder,
  openAiEmbedder,
} from "./embeddings.js"
export { extractDictation } from "./extract-dictation.js"
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js"
export { compileAgentGraph } from "./graph.js"
export { createHelpWriter, fakeHelpWriter } from "./help-writer.js"
export {
  createKairosWriter,
  fakeKairosWriter,
  KAIROS_GOALS,
  type KairosAnnotation,
  type KairosChatModel,
  type KairosClientFacts,
  type KairosUse,
  type KairosWriter,
  type KairosWriterDeps,
  kairosModelNotice,
  readDraft,
  readSummary,
  readWeekly,
} from "./kairos.js"
export {
  checkSellReply,
  claimedActions,
  createKairosSeller,
  fakeSellerModel,
  KAIROS_SELL_FALLBACK,
  KAIROS_SELL_HANDOFF,
  KAIROS_SELL_INTRO,
  KAIROS_SELL_PATIENT,
  type KairosSellBooked,
  type KairosSellChannel,
  type KairosSeller,
  type KairosSellerDeps,
  type KairosSellInput,
  type KairosSellLine,
  type KairosSellResult,
  type KairosSellSlot,
  type KairosSellTools,
  type KairosToolContext,
  SELLER_SYSTEM,
  sellContext,
  sellWhenWords,
} from "./kairos-vende.js"
export {
  AGENT_MODEL,
  createConfiguredChatModel,
  describeProviderProblem,
  fakeModelStartProblem,
  isProviderConfigError,
  LlmConfigError,
  type LlmProvider,
  type LlmSpec,
  llmModelName,
  type PlatformLlm,
  type PlatformLlmEnv,
  type ProviderAccount,
  platformLlmFromEnv,
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
export {
  type AgentRuntime,
  consumeAgentRun,
  type LessonPreview,
  previewLesson,
  processAgentRun,
  type SimulationResult,
  simulateAgentTurn,
} from "./run.js"
export { TOOL_ACTION_LABEL } from "./tools.js"
