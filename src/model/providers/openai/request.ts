import type {
  CanonicalContentBlock,
  CanonicalImageBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalPdfBlock,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../protocol/canonical.js";
import { flattenToolResultBlockText } from "../../protocol/toolResultContent.js";

export type OpenAIRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  temperature?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * Provider-native structured output. Set when `request.outputSchema` is
   * provided. `strict` defaults to true unless the schema opts out.
   */
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
};

type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

const MAX_OPENAI_MESSAGE_CHARS = 120_000;
const MAX_OPENAI_TOOL_RESULT_CHARS = 6_000;
const MAX_OPENAI_TEXT_CONTENT_CHARS = 20_000;

export function buildOpenAIRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
): OpenAIRequestBody {
  const messages = compactOpenAIMessages(
    flattenCompletedToolHistory(
      request.messages.flatMap((message, messageIndex) => toOpenAIMessages(message, messageIndex)),
    ),
  );
  if (request.systemPrompt) {
    messages.unshift({ role: "system", content: request.systemPrompt });
  }

  const body: OpenAIRequestBody = {
    model: request.model,
    messages,
    max_tokens: request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    tools: request.tools?.map(toOpenAITool),
    tool_choice: toOpenAIToolChoice(request.toolChoice),
    temperature: request.temperature,
    stream: request.stream,
    metadata: request.metadata
      ? Object.fromEntries(
          Object.entries(request.metadata).map(([k, v]) => [k, String(v)]),
        )
      : undefined,
  };

  if (request.outputSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.outputSchema.name,
        description: request.outputSchema.description,
        schema: request.outputSchema.schema,
        strict: request.outputSchema.strict ?? true,
      },
    };
  }

  return body;
}

function toOpenAIMessages(message: CanonicalMessage, messageIndex: number): OpenAIMessage[] {
  if (message.role === "user") {
    return toOpenAIUserMessages(message);
  }

  const toolResultBlocks = message.content
    .filter((block) => block.type === "tool_result");
  const toolResultMessages = toolResultBlocks.map(toOpenAIToolResultMessage);
  const toolResultVisualMessages = toolResultBlocks.flatMap(toOpenAIToolResultVisualMessages);

  const toolResultRefMessages = message.content
    .filter((block) => block.type === "tool_result_reference")
    .map(toOpenAIToolResultReferenceMessage);

  const assistantToolCalls = message.content
    .filter((block) => block.type === "tool_call")
    .map((block, toolCallIndex) => ({
      id: normalizeToolCallId(block.id, messageIndex, toolCallIndex),
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));

  const thinkingBlocks = message.content.filter((block) => block.type === "thinking");
  const normalContent = message.content.filter(
    (block) =>
      block.type !== "tool_result" &&
      block.type !== "tool_result_reference" &&
      block.type !== "tool_call" &&
      block.type !== "thinking",
  );

  const messages: OpenAIMessage[] = [];
  if (normalContent.length > 0 || assistantToolCalls.length > 0 || thinkingBlocks.length > 0) {
    const msg: OpenAIMessage = {
      role: message.role,
      content: normalContent.length > 0
        ? toOpenAIContent(normalContent)
        : (message.role === "assistant" && thinkingBlocks.length > 0 ? "" : undefined),
      tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
    };
    // DeepSeek V4 requires reasoning_content to be passed back on assistant
    // messages in multi-turn conversations; omitting it causes a 400 error.
    if (message.role === "assistant" && thinkingBlocks.length > 0) {
      msg.reasoning_content = thinkingBlocks.map((b) => b.text).join("\n");
    }
    messages.push(msg);
  }

  return [...messages, ...toolResultMessages, ...toolResultRefMessages, ...toolResultVisualMessages];
}

function toOpenAIUserMessages(message: CanonicalMessage): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  let normalContent: CanonicalContentBlock[] = [];

  const flushNormalContent = () => {
    if (normalContent.length === 0) return;
    messages.push({
      role: "user",
      content: toOpenAIContent(normalContent),
    });
    normalContent = [];
  };

  for (let i = 0; i < message.content.length; i += 1) {
    const block = message.content[i];
    if (block.type === "tool_result") {
      flushNormalContent();
      const visualContent: (CanonicalImageBlock | CanonicalPdfBlock)[] = [];
      while (i < message.content.length) {
        const toolBlock = message.content[i];
        if (toolBlock.type === "tool_result") {
          messages.push(toOpenAIToolResultMessage(toolBlock));
          visualContent.push(...toolResultVisualContent(toolBlock));
          i += 1;
          continue;
        }
        if (toolBlock.type === "tool_result_reference") {
          messages.push(toOpenAIToolResultReferenceMessage(toolBlock));
          i += 1;
          continue;
        }
        break;
      }
      i -= 1;
      if (visualContent.length > 0) {
        messages.push({
          role: "user",
          content: summarizeToolResultVisuals("inline", visualContent),
        });
      }
      continue;
    }
    if (block.type === "tool_result_reference") {
      flushNormalContent();
      messages.push(toOpenAIToolResultReferenceMessage(block));
      continue;
    }
    normalContent.push(block);
  }

  flushNormalContent();
  return messages;
}

function toOpenAIToolResultMessage(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): OpenAIMessage {
  return {
    role: "tool",
    tool_call_id: block.toolCallId,
    content: truncateText(
      flattenToolResultBlockText(block),
      MAX_OPENAI_TOOL_RESULT_CHARS,
      `tool result ${block.toolCallId}`,
    ),
  };
}

function toOpenAIToolResultVisualMessages(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): OpenAIMessage[] {
  const visualContent = toolResultVisualContent(block);
  if (visualContent.length === 0) {
    return [];
  }
  return [{
    role: "user",
    content: summarizeToolResultVisuals(block.toolCallId, visualContent),
  }];
}

function summarizeToolResultVisuals(
  toolCallId: string,
  visualContent: (CanonicalImageBlock | CanonicalPdfBlock)[],
): string {
  const parts = visualContent.map((block, index) => {
    if (block.type === "image") {
      const size = block.bytes ? `, ${block.bytes} bytes` : "";
      return `image ${index + 1}: ${block.mimeType}${size}`;
    }
    return `pdf ${index + 1}: ${block.mimeType}, ${block.bytes} bytes${block.pages ? `, ${block.pages} pages` : ""}`;
  });
  return [
    `[Visual output from tool result ${toolCallId} omitted from repeated model context to keep the request small and tool-call history valid.]`,
    ...parts,
    "If the visual needs inspection, re-open the saved file/path or ask for a targeted screenshot summary.",
  ].join("\n");
}

function toolResultVisualContent(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): (CanonicalImageBlock | CanonicalPdfBlock)[] {
  return block.content.filter(
    (content): content is CanonicalImageBlock | CanonicalPdfBlock =>
      content.type === "image" || content.type === "pdf",
  );
}

function toOpenAIToolResultReferenceMessage(
  block: Extract<CanonicalContentBlock, { type: "tool_result_reference" }>,
): OpenAIMessage {
  return {
    role: "tool",
    tool_call_id: block.toolCallId,
    content: truncateText(block.preview + (block.hasMore
      ? `\n\n[Truncated: original ${block.originalBytes} bytes, file: ${block.path}]`
      : ""), MAX_OPENAI_TOOL_RESULT_CHARS, `tool result reference ${block.toolCallId}`),
  };
}

function toOpenAIContent(blocks: CanonicalContentBlock[]): string | unknown[] {
  if (blocks.every((block) => block.type === "text")) {
    return truncateText(blocks.map((block) => block.text).join("\n"), MAX_OPENAI_TEXT_CONTENT_CHARS, "message");
  }

  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: truncateText(block.text, MAX_OPENAI_TEXT_CONTENT_CHARS, "message") };
      case "thinking":
        return { type: "text", text: truncateText(block.text, MAX_OPENAI_TEXT_CONTENT_CHARS, "thinking") };
      case "image":
        return {
          type: "image_url",
          image_url: {
            url: block.source === "url" ? block.data : `data:${block.mimeType};base64,${block.data}`,
            detail: block.detail,
          },
        };
      case "audio":
        return block.source === "url"
          ? { type: "input_audio", audio_url: block.data }
          : { type: "input_audio", input_audio: { data: block.data, format: block.mimeType } };
      case "pdf":
        return {
          type: "image_url",
          image_url: {
            url: `data:${block.mimeType};base64,${block.data}`,
          },
        };
      case "tool_call":
      case "tool_result":
        return undefined;
      case "tool_result_reference":
        return { type: "text", text: truncateText(block.preview, MAX_OPENAI_TOOL_RESULT_CHARS, "tool result reference") };
    }
  }).filter(Boolean);
}

function toOpenAITool(tool: CanonicalToolSchema): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeOpenAISchema(tool.inputSchema),
    },
  };
}

/**
 * Azure/OpenAI-compatible endpoints can require `items` whenever a schema node
 * allows `array` (including union types like `type: ["string", "array"]`).
 * Normalize tool input schemas defensively to avoid provider-side 400s.
 */
function normalizeOpenAISchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeOpenAISchemaNode(schema) as Record<string, unknown>;
}

function normalizeOpenAISchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeOpenAISchemaNode);
  }
  if (!isRecord(node)) {
    return node;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    normalized[key] = normalizeOpenAISchemaNode(value);
  }

  const typeField = normalized.type;
  const allowsArray = typeField === "array"
    || (Array.isArray(typeField) && typeField.includes("array"));
  if (allowsArray && !("items" in normalized)) {
    normalized.items = {};
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolCallId(id: unknown, messageIndex: number, toolCallIndex: number): string {
  return typeof id === "string" && id.trim().length > 0
    ? id
    : `call_${messageIndex}_${toolCallIndex}`;
}

/**
 * Last-resort safety net for OpenAI's strict tool-pairing rules:
 *  - normalize every assistant `tool_calls[]` item to the required shape;
 *  - keep only immediately-following tool messages whose `tool_call_id`
 *    matches that assistant message;
 *  - inject placeholders for missing tool results;
 *  - downgrade orphaned / duplicate / mismatched `role: "tool"` messages
 *    to ordinary user summaries. MiniMax's Anthropic-compatible upstream is
 *    strict about tool_result ordering even behind an OpenAI-compatible
 *    facade; sending a bare role=tool message causes 400 "tool call and
 *    result not match".
 */
function repairOpenAIToolPairing(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "assistant" || !msg.tool_calls?.length) {
      if (msg.role !== "tool") {
        out.push(msg);
      } else {
        out.push(orphanToolMessageToUserSummary(msg));
      }
      continue;
    }

    const toolCalls = msg.tool_calls.map((toolCall, toolCallIndex) =>
      normalizeOpenAIToolCall(toolCall, i, toolCallIndex)
    );
    out.push({ ...msg, tool_calls: toolCalls });

    const expectedIds = new Set(toolCalls.map((tc) => tc.id));
    const matchedIds = new Set<string>();
    const orphanSummaries: OpenAIMessage[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const tid = messages[j].tool_call_id;
      if (
        typeof tid === "string" &&
        tid.trim().length > 0 &&
        expectedIds.has(tid) &&
        !matchedIds.has(tid)
      ) {
        out.push(compactToolMessage(messages[j]));
        matchedIds.add(tid);
      } else {
        orphanSummaries.push(orphanToolMessageToUserSummary(messages[j]));
      }
      j++;
    }

    // Inject placeholders for any still-missing results.
    for (const missingId of expectedIds) {
      if (matchedIds.has(missingId)) {
        continue;
      }
      out.push({
        role: "tool",
        tool_call_id: missingId,
        content: "[result truncated]",
      });
    }
    out.push(...orphanSummaries);
    i = j - 1;
  }
  return out;
}

/**
 * MiniMax's Anthropic-compatible upstream is very strict about replayed tool
 * history. A completed PilotDeck turn may contain assistant tool_calls,
 * tool_result messages, and supplemental user media messages. OpenAI accepts
 * that shape more leniently, but MiniMax can reject it with 2013 when any
 * historical pairing is no longer exactly adjacent after compaction/routing.
 *
 * We keep future tool use enabled by still sending `tools` on the request, but
 * flatten already-completed tool calls/results into normal conversational
 * context. The model still sees what happened; the upstream no longer has to
 * validate old tool_call/tool_result protocol pairs.
 */
function flattenCompletedToolHistory(messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return orphanToolMessageToUserSummary(message);
    }

    if (message.role === "assistant" && isLeakedInternalToolSummary(message.content)) {
      return {
        role: "user",
        content: "[Internal tool-history repair note omitted. Continue from the latest real user request.]",
      };
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const text = openAIMessageContentToText(message.content);
      const toolSummary = summarizeToolCalls(message.tool_calls);
      return {
        role: "user",
        content: truncateText(
          [
            "[Internal context from an earlier completed assistant tool step. Do not repeat this block to the user; use it only to understand what has already been attempted.]",
            text ? `Assistant note before tools:\n${text}` : "",
            toolSummary,
          ].filter(Boolean).join("\n\n"),
          MAX_OPENAI_TEXT_CONTENT_CHARS,
          "assistant tool history",
        ),
      };
    }

    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: compactOpenAIContentParts(message.content),
      };
    }

    return message;
  });
}

function compactOpenAIMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const compacted = messages.map((message) => {
    if (message.role === "tool") {
      return compactToolMessage(message);
    }
    if (typeof message.content === "string") {
      return {
        ...message,
        content: truncateText(message.content, MAX_OPENAI_TEXT_CONTENT_CHARS, `${message.role} message`),
      };
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: compactOpenAIContentParts(message.content),
      };
    }
    return message;
  });

  let totalChars = openAIMessagesCharLength(compacted);
  if (totalChars <= MAX_OPENAI_MESSAGE_CHARS) {
    return compacted;
  }

  const kept: OpenAIMessage[] = [];
  for (let i = compacted.length - 1; i >= 0; i--) {
    const candidate = compacted[i];
    const next = [candidate, ...kept];
    if (openAIMessagesCharLength(next) > MAX_OPENAI_MESSAGE_CHARS && kept.length > 0) {
      break;
    }
    kept.unshift(candidate);
  }

  totalChars = openAIMessagesCharLength(kept);
  return [
    {
      role: "user",
      content: `[Earlier conversation and tool logs were compacted before sending to the model to keep the request valid. Retained recent context: ${totalChars} characters.]`,
    },
    ...flattenCompletedToolHistory(kept),
  ];
}

function compactToolMessage(message: OpenAIMessage): OpenAIMessage {
  return {
    ...message,
    content: typeof message.content === "string"
      ? truncateText(message.content, MAX_OPENAI_TOOL_RESULT_CHARS, `tool result ${message.tool_call_id ?? ""}`)
      : message.content,
  };
}

function orphanToolMessageToUserSummary(message: OpenAIMessage): OpenAIMessage {
  const content = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content ?? "");
  return {
    role: "user",
    content: truncateText(
      `[Tool result from earlier or incomplete turn; no matching tool call is present in the retained context. tool_call_id=${message.tool_call_id ?? "unknown"}]\n${content}`,
      MAX_OPENAI_TOOL_RESULT_CHARS,
      "orphan tool result",
    ),
  };
}

function summarizeToolCalls(toolCalls: unknown[]): string {
  const summaries = toolCalls.map((toolCall, index) => {
    const normalized = normalizeOpenAIToolCall(toolCall, 0, index);
    const args = truncateText(normalized.function.arguments, 800, `tool call ${normalized.function.name} arguments`);
    return `- ${normalized.function.name || "tool"}(${args})`;
  });
  return `Completed earlier tool calls:\n${summaries.join("\n")}`;
}

function openAIMessageContentToText(content: OpenAIMessage["content"]): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return compactOpenAIContentParts(content).map((part) => {
    if (!isRecord(part)) {
      return "";
    }
    if (typeof part.text === "string") {
      return part.text;
    }
    return JSON.stringify(part);
  }).filter(Boolean).join("\n");
}

function isLeakedInternalToolSummary(content: OpenAIMessage["content"]): boolean {
  const text = openAIMessageContentToText(content).trim();
  return text.startsWith("[Completed tool calls from earlier turn]")
    || text.startsWith("Completed earlier tool calls:")
    || text.startsWith("[Internal context from an earlier completed assistant tool step.");
}

function compactOpenAIContentParts(content: unknown[]): unknown[] {
  let visualCount = 0;
  return content.map((part) => {
    if (!isRecord(part)) {
      return part;
    }

    if (part.type === "text" && typeof part.text === "string") {
      return {
        ...part,
        text: truncateText(part.text, MAX_OPENAI_TEXT_CONTENT_CHARS, "message"),
      };
    }

    if (part.type === "image_url") {
      visualCount += 1;
      const imageUrl = isRecord(part.image_url) ? part.image_url : {};
      const url = typeof imageUrl.url === "string" ? imageUrl.url : "";
      if (visualCount > 4 || url.length > 80_000) {
        return {
          type: "text",
          text: `[Large visual content omitted from repeated model request: image ${visualCount}, ${url.length} chars. Use the original attachment or ask to inspect the PDF page again if needed.]`,
        };
      }
      return part;
    }

    return part;
  });
}

function openAIMessagesCharLength(messages: OpenAIMessage[]): number {
  return JSON.stringify(messages).length;
}

function truncateText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.2));
  return `${head}\n\n[${label} truncated: ${text.length} chars -> ${maxChars} chars]\n\n${tail}`;
}

function normalizeOpenAIToolCall(
  toolCall: unknown,
  messageIndex: number,
  toolCallIndex: number,
): { id: string; type: "function"; function: { name: string; arguments: string } } {
  const record = isRecord(toolCall) ? toolCall : {};
  const fn = isRecord(record.function) ? record.function : {};
  const args = fn.arguments;
  return {
    id: normalizeToolCallId(record.id, messageIndex, toolCallIndex),
    type: "function",
    function: {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}

function toOpenAIToolChoice(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  return { type: "function", function: { name: toolChoice.name } };
}
