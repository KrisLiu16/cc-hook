#!/usr/bin/env node

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { FeishuClient } from "./feishu.js";
import {
  buildThinkingCard,
  buildWorkingCard,
  buildDoneCard,
  toFeishuMarkdown,
  toolDisplay,
  toolLabel,
  type StepInfo,
} from "./card.js";
import { installHooks, uninstallHooks } from "./install.js";

// --- Bridge detection ---

let _isBridge: boolean | undefined;

/** Check if parent process (Claude Code) was launched by mini-bridge */
function isBridgeSession(): boolean {
  if (_isBridge !== undefined) return _isBridge;
  try {
    const args = execSync(`ps -p ${process.ppid} -o args=`, {
      timeout: 1000,
    }).toString();
    _isBridge = args.includes("mini-bridge");
  } catch {
    _isBridge = false;
  }
  return _isBridge;
}

// --- State ---

const STATE_PATH = "/tmp/cc-hook-state.json";

interface State {
  enabled: boolean;
  chat_id: string;
  session_id?: string;
  pending_bind?: boolean;
  message_id?: string;
  step_count?: number;
  start_time?: number;
  steps?: StepInfo[];
  bot_name?: string;
}

function readState(): State | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return "{}";
    return readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
}

// --- Filters ---

const FILTERED = new Set([
  "TodoWrite",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
]);

function isFiltered(name: string): boolean {
  if (!name) return true;
  if (FILTERED.has(name)) return true;
  if (name.startsWith("mcp__mini-bridge__lark_")) return true;
  return false;
}

// --- Token counting ---

interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function countTokens(transcriptPath: string): TokenStats {
  const stats: TokenStats = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    // Sum output across all turns, but use last message for context size
    let lastUsage: Record<string, number> | null = null;
    for (const line of lines) {
      const entry = JSON.parse(line);
      const usage = entry?.message?.usage;
      if (!usage) continue;
      stats.output += usage.output_tokens || 0;
      lastUsage = usage;
    }
    // Context size ≈ last message's cache_read + cache_creation + input
    if (lastUsage) {
      stats.input = lastUsage.input_tokens || 0;
      stats.cacheRead = lastUsage.cache_read_input_tokens || 0;
      stats.cacheCreate = lastUsage.cache_creation_input_tokens || 0;
    }
  } catch {
    /* best effort */
  }
  return stats;
}

function getLastThinking(transcriptPath: string): string {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    // Search from end for the last assistant message with thinking
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry?.type !== "assistant") continue;
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "thinking" && c.thinking) return c.thinking;
      }
    }
  } catch { /* best effort */ }
  return "";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

// --- Helpers ---

function formatTime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// --- Hook handlers ---

/**
 * UserPromptSubmit — fires when user sends a message.
 * Creates the card immediately and binds session_id.
 */
async function handlePrompt(): Promise<void> {
  const state = readState();
  if (!state?.enabled || !state.chat_id) return;
  if (!isBridgeSession()) return;

  const raw = readStdin();
  writeFileSync("/tmp/cc-hook-debug.log", `prompt raw: ${raw}\n`);
  const input = JSON.parse(raw);
  const sessionId: string = input.session_id || "";
  const prompt: string = input.prompt || "";

  // Always rebind session on UserPromptSubmit — handles restarts gracefully
  if (sessionId) {
    state.session_id = sessionId;
    state.pending_bind = undefined;
  }

  const client = await FeishuClient.create();
  if (!client) return;

  // Fetch and cache bot name
  if (!state.bot_name) {
    const name = await client.getBotName();
    if (name) state.bot_name = name;
  }

  const now = Math.floor(Date.now() / 1000);
  const botName = state.bot_name || "MiniMax AI";

  // Reset state for new turn — create fresh card
  const card = buildThinkingCard(prompt, botName);
  const messageId = await client.sendCard(state.chat_id, card);

  writeState({
    ...state,
    session_id: state.session_id || sessionId || undefined,
    message_id: messageId || undefined,
    step_count: 0,
    start_time: now,
    steps: [],
  });

}

async function handlePre(): Promise<void> {
  const state = readState();
  if (!state?.enabled || !state.chat_id) return;
  if (state.pending_bind) return;
  if (!isBridgeSession()) return;

  const raw = readStdin();
  appendFileSync("/tmp/cc-hook-debug.log", `pre raw: ${raw.slice(0, 200)}\nsid_match: state=${state.session_id} \n`);
  const input = JSON.parse(raw);
  const sessionId: string = input.session_id || "";

  if (state.session_id && state.session_id !== sessionId) return;

  const toolName: string = input.tool_name || "";
  if (isFiltered(toolName)) return;

  const client = await FeishuClient.create();
  if (!client) return;

  const now = Math.floor(Date.now() / 1000);
  const startTime = state.start_time || now;
  const stepCount = (state.step_count || 0) + 1;
  const steps: StepInfo[] = state.steps || [];
  const toolInput = input.tool_input || {};
  const display = toolDisplay(toolName, toolInput);
  const label = toolLabel(toolName, toolInput);
  const elapsed = formatTime(now - startTime);

  const pastSteps = steps.slice(-12);

  const botName = state.bot_name || "MiniMax AI";
  const card = buildWorkingCard(display, pastSteps, stepCount, elapsed, botName, toolName);

  let messageId = state.message_id;
  if (!messageId) {
    messageId = await client.sendCard(state.chat_id, card);
    appendFileSync("/tmp/cc-hook-debug.log", `pre sendCard result: ${messageId}\n`);
  } else {
    await client.updateCard(messageId, card);
    appendFileSync("/tmp/cc-hook-debug.log", `pre updateCard: ${messageId}\n`);
  }

  steps.push({ tool: toolName, label });
  writeState({
    ...state,
    message_id: messageId || undefined,
    step_count: stepCount,
    start_time: startTime,
    steps: steps.slice(-20),
  });
}

/**
 * PostToolUse — binds session_id if still pending (fallback for no-prompt hook).
 */
async function handlePost(): Promise<void> {
  const state = readState();
  if (!state?.pending_bind) return;
  if (!isBridgeSession()) return;

  const input = JSON.parse(readStdin());
  const sessionId: string = input.session_id || "";
  if (!sessionId) return;

  state.session_id = sessionId;
  state.pending_bind = undefined;
  writeState(state);
}

/**
 * SubagentStart — show agent spawn in steps.
 */
async function handleSubagentStart(): Promise<void> {
  const state = readState();
  if (!state?.enabled || !state.chat_id || !state.message_id) return;
  if (!isBridgeSession()) return;

  const input = JSON.parse(readStdin());
  const sessionId: string = input.session_id || "";
  if (state.session_id && state.session_id !== sessionId) return;

  const agentType: string = input.agent_type || "subagent";

  const client = await FeishuClient.create();
  if (!client) return;

  const now = Math.floor(Date.now() / 1000);
  const startTime = state.start_time || now;
  const stepCount = (state.step_count || 0) + 1;
  const steps: StepInfo[] = state.steps || [];
  const elapsed = formatTime(now - startTime);

  const display = `Sub-Agent: ${agentType}`;
  const pastSteps = steps.slice(-12);

  const botName = state.bot_name || "MiniMax AI";
  const card = buildWorkingCard(display, pastSteps, stepCount, elapsed, botName, "Agent");
  await client.updateCard(state.message_id, card);

  steps.push({ tool: "Agent", label: `Sub-Agent: ${agentType}` });
  writeState({
    ...state,
    step_count: stepCount,
    steps: steps.slice(-20),
  });
}

/**
 * SubagentStop — show agent completion in steps.
 */
async function handleSubagentStop(): Promise<void> {
  const state = readState();
  if (!state?.enabled || !state.chat_id || !state.message_id) return;
  if (!isBridgeSession()) return;

  const input = JSON.parse(readStdin());
  const sessionId: string = input.session_id || "";
  if (state.session_id && state.session_id !== sessionId) return;

  const agentType: string = input.agent_type || "subagent";

  const client = await FeishuClient.create();
  if (!client) return;

  const now = Math.floor(Date.now() / 1000);
  const startTime = state.start_time || now;
  const stepCount = (state.step_count || 0) + 1;
  const steps: StepInfo[] = state.steps || [];
  const elapsed = formatTime(now - startTime);

  const display = `Sub-Agent: ${agentType} Done`;
  const pastSteps = steps.slice(-12);

  const botName = state.bot_name || "MiniMax AI";
  const card = buildWorkingCard(display, pastSteps, stepCount, elapsed, botName, "Agent");
  await client.updateCard(state.message_id, card);

  steps.push({ tool: "Agent", label: `Sub-Agent: ${agentType} Done` });
  writeState({
    ...state,
    step_count: stepCount,
    steps: steps.slice(-20),
  });
}

async function handleStop(): Promise<void> {
  const raw = readStdin();
  appendFileSync("/tmp/cc-hook-debug.log", `stop raw: ${raw.slice(0, 500)}\n`);

  const state = readState();
  if (!state?.enabled || !state.chat_id) return;
  if (!isBridgeSession()) return;

  const input = JSON.parse(raw);
  const sessionId: string = input.session_id || "";
  const stopHookActive: boolean = input.stop_hook_active || false;
  const lastMessage: string = input.last_assistant_message || "";

  if (state.session_id && state.session_id !== sessionId) return;

  // --- Second stop (after block) — just reset and let Claude stop ---
  if (stopHookActive) {
    appendFileSync("/tmp/cc-hook-debug.log", `stop: second pass, allowing stop\n`);
    writeState({
      enabled: true,
      chat_id: state.chat_id,
      session_id: state.session_id,
      bot_name: state.bot_name,
    });
    return; // exit 0 → Claude stops
  }

  // --- First stop — send reply card, then terminate ---
  const client = await FeishuClient.create();
  if (!client) return;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = formatTime(now - (state.start_time || now));
  const stepCount = state.step_count || 0;
  const steps: StepInfo[] = state.steps || [];

  const botName = state.bot_name || "MiniMax AI";
  const reply = lastMessage ? toFeishuMarkdown(lastMessage) : "";
  const tPath: string = input.transcript_path || "";
  const thinking = tPath ? getLastThinking(tPath) : "";

  // Update existing card to done (reply + collapsible history + thinking)
  if (state.message_id) {
    const doneCard = buildDoneCard(reply, steps, stepCount, elapsed, botName, thinking);
    await client.updateCard(state.message_id, doneCard);
  } else if (reply) {
    const doneCard = buildDoneCard(reply, steps, stepCount, elapsed, botName, thinking);
    await client.sendCard(state.chat_id, doneCard);
  }

  appendFileSync("/tmp/cc-hook-debug.log", `stop: first pass, blocking → summary\n`);

  // Build a short status line for bridge to forward
  const transcriptPath: string = input.transcript_path || "";
  const tokens = transcriptPath ? countTokens(transcriptPath) : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const ctx = tokens.input + tokens.cacheRead + tokens.cacheCreate;
  const pct = Math.round((ctx / 1_000_000) * 100);
  const filled = Math.round(pct / 10);
  const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
  const statusLine = `${bar} ${formatTokens(ctx)} / 1M (${pct}%)`;

  const decision = {
    decision: "block",
    reason: `Your reply has been delivered to the user as a formatted Feishu card. To finish this turn, output ONLY this exact text and nothing else:\n\n${statusLine}`,
  };
  process.stdout.write(JSON.stringify(decision));
}

async function handleEnable(chatId?: string): Promise<void> {
  if (!chatId) {
    try {
      const log = readFileSync(
        `${process.env.HOME}/.mini-bridge/gateway.log`,
        "utf-8",
      );
      const match = log.match(
        /received message from feishu:(oc_[a-f0-9]+):/g,
      );
      if (match) {
        const last = match[match.length - 1];
        chatId = last.match(/feishu:(oc_[a-f0-9]+):/)?.[1];
      }
    } catch {
      /* no log */
    }
  }

  if (!chatId) {
    console.log("Usage: cc-hook on <chat_id>");
    console.log("");
    console.log("Get chat_id from mini-bridge logs:");
    console.log(
      '  grep "received message from feishu" ~/.mini-bridge/gateway.log | tail -1',
    );
    process.exit(1);
  }

  writeState({ enabled: true, chat_id: chatId, pending_bind: true });
  console.log(`Card mode enabled · chat: ${chatId} · awaiting session bind`);
}

function handleDisable(): void {
  const state = readState();
  if (state) {
    writeState({ enabled: false, chat_id: state.chat_id });
  }
  console.log("Card mode disabled");
}

function handleStatus(): void {
  const state = readState();
  if (!state) {
    console.log("Status: not configured");
    return;
  }
  console.log(`Status:   ${state.enabled ? "enabled" : "disabled"}`);
  console.log(`Chat:     ${state.chat_id}`);
  if (state.pending_bind) {
    console.log("Session:  (pending bind)");
  } else {
    console.log(`Session:  ${state.session_id || "(none)"}`);
  }
  if (state.message_id) console.log(`Card:     ${state.message_id}`);
  if (state.step_count) console.log(`Steps:    ${state.step_count}`);
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "prompt":
      await handlePrompt();
      break;
    case "pre":
      await handlePre();
      break;
    case "post":
      await handlePost();
      break;
    case "subagent-start":
      await handleSubagentStart();
      break;
    case "subagent-stop":
      await handleSubagentStop();
      break;
    case "stop":
      await handleStop();
      break;
    case "on":
      await handleEnable(args[0]);
      break;
    case "off":
      handleDisable();
      break;
    case "status":
      handleStatus();
      break;
    case "install":
      installHooks();
      break;
    case "uninstall":
      uninstallHooks();
      break;
    default:
      console.log("cc-hook — Claude Code Feishu Card Plugin");
      console.log("");
      console.log("Setup:");
      console.log(
        "  cc-hook install            Add hooks to Claude Code settings",
      );
      console.log("  cc-hook uninstall          Remove hooks");
      console.log(
        "  cc-hook on [chat_id]       Enable card mode (auto-detects chat)",
      );
      console.log("  cc-hook off                Disable card mode");
      console.log("  cc-hook status             Show current state");
      console.log("");
      console.log("Hook handlers (called by Claude Code):");
      console.log("  cc-hook prompt             UserPromptSubmit");
      console.log("  cc-hook pre                PreToolUse");
      console.log("  cc-hook post               PostToolUse");
      console.log("  cc-hook subagent-start     SubagentStart");
      console.log("  cc-hook subagent-stop      SubagentStop");
      console.log("  cc-hook stop               Stop");
  }
} catch {
  process.exit(0);
}
