import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// All hook events cc-hook handles
const HOOK_EVENTS = [
  { event: "UserPromptSubmit", command: "prompt", matcher: undefined },
  { event: "PreToolUse", command: "pre", matcher: ".*" },
  { event: "PostToolUse", command: "post", matcher: ".*" },
  { event: "SubagentStart", command: "subagent-start", matcher: undefined },
  { event: "SubagentStop", command: "subagent-stop", matcher: ".*" },
  { event: "Stop", command: "stop", matcher: undefined },
] as const;

function makeHooksConfig(bin: string) {
  const config: Record<string, unknown[]> = {};
  for (const { event, command, matcher } of HOOK_EVENTS) {
    const entry: Record<string, unknown> = {
      hooks: [{ type: "command", command: `${bin} ${command}`, timeout: 10 }],
    };
    if (matcher) entry.matcher = matcher;
    config[event] = [entry];
  }
  return config;
}

// Detect the best command to use in hooks
function detectBin(): string {
  const selfPath = process.argv[1];
  if (selfPath) {
    return `node ${selfPath}`;
  }
  return "cc-hook";
}

export function installHooks(): void {
  if (!existsSync(SETTINGS_PATH)) {
    console.error(`Claude Code settings not found: ${SETTINGS_PATH}`);
    console.error("Make sure Claude Code is installed.");
    process.exit(1);
  }

  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));

  // Remove old cc-hook entries first (clean reinstall)
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const hooks = settings.hooks[event];
      if (Array.isArray(hooks)) {
        settings.hooks[event] = hooks.filter(
          (h: Record<string, unknown>) =>
            !JSON.stringify(h).includes("cc-hook"),
        );
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }
  }

  const bin = detectBin();
  settings.hooks = { ...(settings.hooks || {}), ...makeHooksConfig(bin) };
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log("Installed hooks into Claude Code settings.");
  console.log(`Binary: ${bin}`);
  console.log("");
  console.log("Events registered:");
  for (const { event, command } of HOOK_EVENTS) {
    console.log(`  ${event.padEnd(20)} → cc-hook ${command}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code to load hooks");
  console.log("  2. Enable card mode:  cc-hook on <chat_id>");
}

export function uninstallHooks(): void {
  if (!existsSync(SETTINGS_PATH)) return;

  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  if (!settings.hooks) {
    console.log("No hooks found.");
    return;
  }

  for (const event of Object.keys(settings.hooks)) {
    const hooks = settings.hooks[event];
    if (Array.isArray(hooks)) {
      settings.hooks[event] = hooks.filter(
        (h: Record<string, unknown>) =>
          !JSON.stringify(h).includes("cc-hook"),
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log("Hooks removed. Restart Claude Code to apply.");
}
