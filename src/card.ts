// Shorten long paths: /Users/foo/project/src/file.ts → …/src/file.ts
function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

type ToolInput = Record<string, unknown>;

export function toolDisplay(tool: string, input: ToolInput): string {
  const str = (key: string) => (input[key] as string) || "";

  switch (tool) {
    case "Read":
      return `\`READ\`  ${shortPath(str("file_path"))}`;
    case "Edit":
      return `\`EDIT\`  ${shortPath(str("file_path"))}`;
    case "Write":
      return `\`WRITE\` ${shortPath(str("file_path"))}`;
    case "Bash": {
      const cmd = str("command").split("\n")[0]; // first line only
      const short = cmd.slice(0, 60);
      return `\`BASH\`  \`${short}${cmd.length > 60 ? "…" : ""}\``;
    }
    case "Grep":
      return `\`GREP\`  \`${str("pattern")}\`${str("path") ? ` in ${shortPath(str("path"))}` : ""}`;
    case "Glob":
      return `\`GLOB\`  \`${str("pattern")}\``;
    case "Agent":
      return `\`AGENT\` ${str("description")}`;
    case "WebFetch":
      return `\`FETCH\` ${str("url").slice(0, 50)}`;
    case "WebSearch":
      return `\`SEARCH\` ${str("query")}`;
    case "LSP":
      return `\`LSP\`   ${str("operation")} ${shortPath(str("filePath"))}`;
    case "Skill":
      return `\`SKILL\` ${str("skill")}`;
    case "NotebookEdit":
      return `\`NOTEBOOK\` edit`;
    default:
      return `\`${tool.toUpperCase()}\``;
  }
}

/**
 * Schema 2.0 card with body.elements — renders markdown properly
 * (code blocks, inline code, tables, bold/italic all work)
 */
function card2(
  header: { title: string; template: string },
  markdown: string,
) {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: header.title },
      template: header.template,
    },
    body: {
      elements: [{ tag: "markdown", content: markdown }],
    },
  };
}

export function buildWorkingCard(
  current: string,
  history: string,
  stepCount: number,
  elapsed: string,
) {
  const lines = [
    `▸  ${current}`,
    "",
    "---",
    "",
    history,
    "",
    `step ${stepCount} · ${elapsed}`,
  ];
  return card2(
    { title: "Claude Code · Working", template: "blue" },
    lines.join("\n"),
  );
}

export function buildDoneCard(
  history: string,
  stepCount: number,
  elapsed: string,
) {
  const lines = [history, "", `done · ${stepCount} steps · ${elapsed}`];
  return card2(
    { title: "Claude Code · Done", template: "green" },
    lines.join("\n"),
  );
}
