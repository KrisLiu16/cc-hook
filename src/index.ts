#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { FeishuClient } from "./feishu.js";
import { buildWorkingCard, buildDoneCard, toolDisplay } from "./card.js";
import { installHooks, uninstallHooks } from "./install.js";

// --- State ---

const STATE_PATH = "/tmp/cc-hook-state.json";

interface State {
  enabled: boolean;
  chat_id: string;
  session_id?: string; // bound session — only this session sends cards
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

async function handlePre(): Promise<void> {
  const state = readState();
  if (!state?.enabled || !state.chat_id) return;

  const input = JSON.parse(readStdin());
  const sessionId: string = input.session_id || "";

  // Session binding: only the bound session sends cards
  if (state.session_id) {
    if (state.session_id !== sessionId) return; // wrong session, skip
  } else if (sessionId) {
    // First hook after `cc-hook on` — capture this session
    state.session_id = sessionId;
  }

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
  } else {
    await client.updateCard(messageId, card);
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

async function handleStop(): Promise<void> {
  const state = readState();
  if (!state?.enabled || !state.chat_id || !state.message_id) return;

  const input = JSON.parse(readStdin());
  const sessionId: string = input.session_id || "";

  // Only the bound session can finalize the card
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

  // Reset card state, keep session binding
  writeState({
    enabled: state.enabled,
    chat_id: state.chat_id,
    session_id: state.session_id,
  });
}

async function handleEnable(chatId?: string): Promise<void> {
  if (!chatId) {
    // Try to extract from mini-bridge logs
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

  writeState({ enabled: true, chat_id: chatId });
  console.log(`Card mode enabled · chat: ${chatId}`);
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
  console.log(`Session:  ${state.session_id || "(awaiting binding)"}`);
  if (state.message_id) console.log(`Card:     ${state.message_id}`);
  if (state.step_count) console.log(`Steps:    ${state.step_count}`);
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "pre":
      await handlePre();
      break;
    case "post":
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
      console.log("  cc-hook install            Add hooks to Claude Code settings");
      console.log("  cc-hook uninstall          Remove hooks");
      console.log("  cc-hook on [chat_id]       Enable card mode (auto-detects chat)");
      console.log("  cc-hook off                Disable card mode");
      console.log("  cc-hook status             Show current state");
      console.log("");
      console.log("Hook handlers (called by Claude Code, not manually):");
      console.log("  cc-hook pre                PreToolUse");
      console.log("  cc-hook post               PostToolUse");
      console.log("  cc-hook stop               Stop");
  }
} catch {
  // Hooks must never crash Claude Code
  process.exit(0);
}
