import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

function makeHooksConfig(bin: string) {
  return {
    PreToolUse: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${bin} pre`, timeout: 5 }],
      },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${bin} post`, timeout: 5 }],
      },
    ],
    Stop: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${bin} stop`, timeout: 5 }],
      },
    ],
  };
}

// Detect the best command to use in hooks
function detectBin(): string {
  // If globally installed, `cc-hook` should be in PATH
  // Otherwise fall back to absolute path of this script
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

  // Check if already installed
  if (settings.hooks && JSON.stringify(settings.hooks).includes("cc-hook")) {
    console.log("cc-hook already installed in Claude Code settings.");
    return;
  }

  const bin = detectBin();
  settings.hooks = { ...(settings.hooks || {}), ...makeHooksConfig(bin) };
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log("Installed hooks into Claude Code settings.");
  console.log(`Binary: ${bin}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code to load hooks");
  console.log("  2. Enable card mode:  cc-hook on <chat_id>");
  console.log("");
  console.log("Get chat_id from mini-bridge logs:");
  console.log(
    '  grep "received message from feishu" ~/.mini-bridge/gateway.log | tail -1',
  );
}

export function uninstallHooks(): void {
  if (!existsSync(SETTINGS_PATH)) return;

  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  if (!settings.hooks) {
    console.log("No hooks found.");
    return;
  }

  for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
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
