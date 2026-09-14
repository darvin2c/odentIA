import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";

/**
 * Modelo determinista para dev/e2e/tests (LLM_MODEL=fake). Primera llamada:
 * tool call `send_reply` con texto fijo; tras el ToolMessage: texto final.
 */
export const FAKE_REPLY_TEXT = "Gracias por escribir. Te atiendo enseguida.";

export class FakeChatModel extends BaseChatModel {
  _llmType(): string {
    return "fake-chat";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages[messages.length - 1];
    const message =
      last instanceof ToolMessage
        ? new AIMessage({ content: FAKE_REPLY_TEXT })
        : new AIMessage({
            content: "",
            tool_calls: [{ name: "send_reply", args: { text: FAKE_REPLY_TEXT }, id: "call-1", type: "tool_call" }],
          });
    return { generations: [{ text: message.content as string, message }] };
  }
}
