#!/usr/bin/env node

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { FeishuClient } from "./feishu.js";
import {
  buildThinkingCard,
  buildWorkingCard,
  buildDoneCard,
  toolDisplay,
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
  steps?: string[];
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

  const now = Math.floor(Date.now() / 1000);

  // Reset state for new turn — create fresh card
  const card = buildThinkingCard(prompt);
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
  const steps = state.steps || [];
  const display = toolDisplay(toolName, input.tool_input || {});
  const elapsed = formatTime(now - startTime);

  const recentSteps = steps.slice(-12);
  const history =
    recentSteps.length > 0
      ? `**Record** · ${recentSteps.length} steps\n${recentSteps.join("\n")}`
      : "**Record** · starting…";

  const card = buildWorkingCard(display, history, stepCount, elapsed);

  let messageId = state.message_id;
  if (!messageId) {
    messageId = await client.sendCard(state.chat_id, card);
    appendFileSync("/tmp/cc-hook-debug.log", `pre sendCard result: ${messageId}\n`);
  } else {
    await client.updateCard(messageId, card);
    appendFileSync("/tmp/cc-hook-debug.log", `pre updateCard: ${messageId}\n`);
  }

  steps.push(display);
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
  const steps = state.steps || [];
  const elapsed = formatTime(now - startTime);

  const display = `🚀 \`AGENT\` ${agentType} spawned`;

  const recentSteps = steps.slice(-12);
  const history =
    recentSteps.length > 0
      ? `**Record** · ${recentSteps.length} steps\n${recentSteps.join("\n")}`
      : "**Record** · starting…";

  const card = buildWorkingCard(display, history, stepCount, elapsed);
  await client.updateCard(state.message_id, card);

  steps.push(display);
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
  const steps = state.steps || [];
  const elapsed = formatTime(now - startTime);

  const display = `✅ \`AGENT\` ${agentType} done`;

  const recentSteps = steps.slice(-12);
  const history =
    recentSteps.length > 0
      ? `**Record** · ${recentSteps.length} steps\n${recentSteps.join("\n")}`
      : "**Record** · starting…";

  const card = buildWorkingCard(display, history, stepCount, elapsed);
  await client.updateCard(state.message_id, card);

  steps.push(display);
  writeState({
    ...state,
    step_count: stepCount,
    steps: steps.slice(-20),
  });
}

async function handleStop(): Promise<void> {
  const raw = readStdin();
  appendFileSync("/tmp/cc-hook-debug.log", `stop raw: ${raw}\n`);

  const state = readState();
  if (!state?.enabled || !state.chat_id || !state.message_id) return;
  if (!isBridgeSession()) return;

  const input = JSON.parse(raw);
  const sessionId: string = input.session_id || "";

  if (state.session_id && state.session_id !== sessionId) return;

  const client = await FeishuClient.create();
  if (!client) return;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = formatTime(now - (state.start_time || now));
  const stepCount = state.step_count || 0;
  const steps = state.steps || [];

  const history =
    steps.length > 0
      ? `**Record** · ${steps.length} steps\n${steps.join("\n")}`
      : "**Record** · no tool calls";

  const card = buildDoneCard(history, stepCount, elapsed);
  await client.updateCard(state.message_id, card);

  // Reset for next turn — keep enabled, keep session
  writeState({
    enabled: true,
    chat_id: state.chat_id,
    session_id: state.session_id,
  });
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
