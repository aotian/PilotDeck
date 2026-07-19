import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import { SubAgentSession } from "../../src/agent/sub/SubAgentSession.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/index.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

test("per-turn output budget reaches tool context and forked subagent", async () => {
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/tmp/pilotdeck-agent-loop-token-budget",
    maxOutputTokens: 20_000,
    permissionMode: "dontAsk",
    permissionContext: createDefaultPermissionContext({
      cwd: "/tmp/pilotdeck-agent-loop-token-budget",
      mode: "dontAsk",
    }),
  };
  const dependencies = {
    router: {},
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  } as unknown as AgentRuntimeDependencies;
  const loop = new AgentLoop(config, dependencies);
  const input: AgentLoopInput = {
    sessionId: "parent-session",
    turnId: "parent-turn",
    messages: [],
    maxOutputTokens: 80_000,
  };
  const messages: CanonicalMessage[] = [{
    role: "assistant",
    content: [{ type: "text", text: "delegate the deck task" }],
  }];
  const internals = loop as unknown as {
    createToolContext(
      currentInput: AgentLoopInput,
      currentMessages: CanonicalMessage[],
    ): PilotDeckToolRuntimeContext;
  };
  const context = internals.createToolContext(input, messages);

  assert.equal(context.maxOutputTokens, 80_000);
  assert.ok(context.subagent);

  const originalRun = SubAgentSession.prototype.run;
  let inheritedBudget: number | undefined;
  let inheritedMaxTurns: number | undefined;
  SubAgentSession.prototype.run = async function patchedRun() {
    const options = (this as unknown as {
      options: { parentConfig: AgentRuntimeConfig; maxTurns?: number };
    }).options;
    inheritedBudget = options.parentConfig.maxOutputTokens;
    inheritedMaxTurns = options.maxTurns;
    return {
      subagentId: "subagent-1",
      definitionId: "courseware-deck",
      markdown: "ready",
      usage: {},
      turns: 1,
      durationMs: 1,
    };
  };

  try {
    await context.subagent.fork({
      definitionId: "courseware-deck",
      directive: "Generate the approved deck.",
      subagentId: "subagent-1",
      timeoutMs: 1_000,
    });
  } finally {
    SubAgentSession.prototype.run = originalRun;
  }

  assert.equal(inheritedBudget, 80_000);
  assert.equal(inheritedMaxTurns, 24);
});
