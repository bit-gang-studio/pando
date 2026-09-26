import { bundledLanguages, codeToTokens, type BundledLanguage, type ThemedToken } from "shiki";

const EXT: Record<string, BundledLanguage> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", rb: "ruby", go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  json: "json", toml: "toml", yaml: "yaml", yml: "yaml", md: "markdown", html: "html", css: "css",
  scss: "scss", sh: "bash", bash: "bash", zsh: "bash", sql: "sql", xml: "xml", svg: "xml",
  dockerfile: "dockerfile", lua: "lua", ex: "elixir", exs: "elixir", vue: "vue", svelte: "svelte",
};

export function langFor(path: string): BundledLanguage | null {
  const base = path.split("/").pop() ?? path;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  if (base === "justfile") return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const lang = EXT[ext];
  return lang && lang in bundledLanguages ? lang : null;
}

export type Tok = { content: string; color?: string };

/// Tokenize each line of `lines` with context across lines. Returns one token array per input line.
export async function highlightLines(lines: string[], lang: BundledLanguage | null): Promise<Tok[][]> {
  if (!lang || lines.length === 0) return lines.map((l) => [{ content: l }]);
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  try {
    const { tokens } = await codeToTokens(lines.join("\n"), { lang, theme: dark ? "github-dark" : "github-light" });
    return lines.map((l, i) => (tokens[i]?.length ? tokens[i].map((t: ThemedToken) => ({ content: t.content, color: t.color })) : [{ content: l }]));
  } catch {
    return lines.map((l) => [{ content: l }]);
  }
}
