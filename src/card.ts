// Shorten long paths: /Users/foo/project/src/file.ts → …/src/file.ts
function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

type ToolInput = Record<string, unknown>;

export function toolDisplay(tool: string, input: ToolInput): string {
  const tag = `\`${tool.toUpperCase()}\``;
  const str = (key: string) => (input[key] as string) || "";

  switch (tool) {
    case "Read":
      return `${tag}  ${shortPath(str("file_path"))}`;
    case "Edit":
      return `${tag}  ${shortPath(str("file_path"))}`;
    case "Write":
      return `${tag}  ${shortPath(str("file_path"))}`;
    case "Bash": {
      const cmd = str("command");
      const short = cmd.slice(0, 60);
      return `${tag}  ${short}${cmd.length > 60 ? "…" : ""}`;
    }
    case "Grep": {
      const path = str("path");
      return `${tag}  "${str("pattern")}"${path ? ` in ${shortPath(path)}` : ""}`;
    }
    case "Glob":
      return `${tag}  ${str("pattern")}`;
    case "Agent":
      return `${tag}  ${str("description")}`;
    case "WebFetch":
      return `${tag}  ${str("url").slice(0, 50)}`;
    case "WebSearch":
      return `${tag}  ${str("query")}`;
    case "LSP":
      return `${tag}  ${str("operation")} ${shortPath(str("filePath"))}`;
    case "Skill":
      return `${tag}  ${str("skill")}`;
    case "NotebookEdit":
      return `${tag}  edit`;
    default:
      return tag;
  }
}

export function buildWorkingCard(
  current: string,
  history: string,
  stepCount: number,
  elapsed: string,
) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "Claude Code · Working" },
      template: "blue",
    },
    elements: [
      { tag: "markdown" as const, content: `▸ ${current}` },
      { tag: "hr" as const },
      { tag: "markdown" as const, content: history },
      {
        tag: "note" as const,
        elements: [
          {
            tag: "plain_text" as const,
            content: `step ${stepCount} · ${elapsed}`,
          },
        ],
      },
    ],
  };
}

export function buildDoneCard(
  history: string,
  stepCount: number,
  elapsed: string,
) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "Claude Code · Done" },
      template: "green",
    },
    elements: [
      { tag: "markdown" as const, content: history },
      {
        tag: "note" as const,
        elements: [
          {
            tag: "plain_text" as const,
            content: `done · ${stepCount} steps · ${elapsed}`,
          },
        ],
      },
    ],
  };
}
