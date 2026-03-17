// Shorten long paths: /Users/foo/project/src/file.ts → …/src/file.ts
function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

type ToolInput = Record<string, unknown>;

const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Edit: "✏️",
  Write: "📝",
  Bash: "⚡",
  Grep: "🔍",
  Glob: "📁",
  Agent: "🤖",
  WebFetch: "🌐",
  WebSearch: "🔎",
  LSP: "🧩",
  Skill: "🎯",
  NotebookEdit: "📓",
};

export function toolDisplay(tool: string, input: ToolInput): string {
  const str = (key: string) => (input[key] as string) || "";
  const emoji = TOOL_EMOJI[tool] || "⚙️";

  switch (tool) {
    case "Read":
      return `${emoji} \`READ\`  ${shortPath(str("file_path"))}`;
    case "Edit":
      return `${emoji} \`EDIT\`  ${shortPath(str("file_path"))}`;
    case "Write":
      return `${emoji} \`WRITE\` ${shortPath(str("file_path"))}`;
    case "Bash": {
      const cmd = str("command").split("\n")[0];
      const short = cmd.slice(0, 55);
      return `${emoji} \`BASH\`  \`${short}${cmd.length > 55 ? "…" : ""}\``;
    }
    case "Grep":
      return `${emoji} \`GREP\`  \`${str("pattern")}\`${str("path") ? ` in ${shortPath(str("path"))}` : ""}`;
    case "Glob":
      return `${emoji} \`GLOB\`  \`${str("pattern")}\``;
    case "Agent":
      return `${emoji} \`AGENT\` ${str("description")}`;
    case "WebFetch":
      return `${emoji} \`FETCH\` ${str("url").slice(0, 50)}`;
    case "WebSearch":
      return `${emoji} \`SEARCH\` ${str("query")}`;
    case "LSP":
      return `${emoji} \`LSP\`   ${str("operation")} ${shortPath(str("filePath"))}`;
    case "Skill":
      return `${emoji} \`SKILL\` ${str("skill")}`;
    case "NotebookEdit":
      return `${emoji} \`NOTEBOOK\` edit`;
    default:
      return `${emoji} \`${tool.toUpperCase()}\``;
  }
}

// --- Card JSON 2.0 builders ---

interface CardHeader {
  title: { tag: "plain_text"; content: string };
  subtitle?: { tag: "plain_text"; content: string };
  template: string;
  icon?: { tag: "standard_icon"; token: string; color?: string };
  text_tag_list?: Array<{
    tag: "text_tag";
    text: { tag: "plain_text"; content: string };
    color: string;
  }>;
}

function makeHeader(opts: {
  title: string;
  subtitle?: string;
  template: string;
  icon: string;
  tagText: string;
  tagColor: string;
}): CardHeader {
  const header: CardHeader = {
    title: { tag: "plain_text", content: opts.title },
    template: opts.template,
    icon: { tag: "standard_icon", token: opts.icon },
    text_tag_list: [
      {
        tag: "text_tag",
        text: { tag: "plain_text", content: opts.tagText },
        color: opts.tagColor,
      },
    ],
  };
  if (opts.subtitle) {
    header.subtitle = { tag: "plain_text", content: opts.subtitle };
  }
  return header;
}

/** Thinking card — shown immediately when user submits prompt */
export function buildThinkingCard(prompt: string, botName = "MiniMax AI") {
  const short = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: botName,
      subtitle: "thinking…",
      template: "blue",
      icon: "chat_outlined",
      tagText: "思考中",
      tagColor: "blue",
    }),
    body: {
      elements: [
        { tag: "markdown", content: `💬 ${short}` },
        { tag: "markdown", content: `<font color='grey'>waiting for first action…</font>` },
      ],
    },
  };
}

/** Working card — updated on each tool call */
export function buildWorkingCard(
  current: string,
  history: string,
  stepCount: number,
  elapsed: string,
  botName = "MiniMax AI",
) {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: botName,
      subtitle: `step ${stepCount} · ${elapsed}`,
      template: "blue",
      icon: "loop_outlined",
      tagText: "执行中",
      tagColor: "blue",
    }),
    body: {
      elements: [
        { tag: "markdown", content: `▸ ${current}` },
        { tag: "hr" },
        { tag: "markdown", content: history },
        { tag: "markdown", content: `<font color='grey'>step ${stepCount} · ${elapsed}</font>` },
      ],
    },
  };
}

/** Convert standard markdown to Feishu card-compatible markdown */
export function toFeishuMarkdown(md: string): string {
  return md
    // Headers → bold (Feishu cards don't support # headers)
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**")
    // Blockquotes → just remove the > prefix
    .replace(/^>\s?/gm, "");
}

/** Done card — final state (no reply) */
export function buildDoneCard(
  history: string,
  stepCount: number,
  elapsed: string,
  botName = "MiniMax AI",
) {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: botName,
      subtitle: `${stepCount} steps · ${elapsed}`,
      template: "green",
      icon: "succeed_outlined",
      tagText: "已完成",
      tagColor: "green",
    }),
    body: {
      elements: [
        { tag: "markdown", content: history },
        { tag: "markdown", content: `<font color='grey'>done · ${stepCount} steps · ${elapsed}</font>` },
      ],
    },
  };
}

/** Reply card — standalone card for the formatted response */
export function buildReplyCard(reply: string, botName = "MiniMax AI") {
  const maxLen = 2500;
  const truncated =
    reply.length > maxLen ? reply.slice(0, maxLen) + "\n\n…(truncated)" : reply;

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: makeHeader({
      title: botName,
      template: "purple",
      icon: "chat_outlined",
      tagText: "回复",
      tagColor: "purple",
    }),
    body: {
      elements: [{ tag: "markdown", content: truncated }],
    },
  };
}
