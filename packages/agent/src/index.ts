/**
 * @odentia/agent: agente omnicanal (LangGraph). Todo lo de IA vive aquí;
 * el worker solo encola/desencola y aporta env.
 */
export type { QueueMessage } from "@odentia/db"
export { FAKE_REPLY_TEXT, FakeChatModel } from "./fake-model.js"
export { compileAgentGraph } from "./graph.js"
export {
  createConfiguredChatModel,
  describeProviderProblem,
  isProviderConfigError,
  LlmConfigError,
  type LlmConnectionTest,
  type LlmSpec,
  type OrgLlmSecrets,
  type PlatformLlm,
  resolveLlmSpec,
  resolveModelName,
  testLlmConnection,
} from "./llm.js"
export { assertSafeBaseUrl, createPinnedDispatcher, isPrivateAddress, parseLlmBaseUrl, parseSafeBaseUrl } from "./llm-endpoint.js"
export * from "./decision/index.js"
export { runShadowTriage } from "./decision/shadow.js"
export {
  type AgentRuntime,
  consumeAgentRun,
  processAgentRun,
  EMPTY_SANDBOX_STATE,
  resolveOrgLlm,
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
