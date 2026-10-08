import { bundledLanguages, codeToTokens, type BundledLanguage, type ThemedToken } from "shiki";

// Shiki knows about 240 languages, under their names and short names ("ts",
// "py", "yml"). Most file endings are one of those. These are the ones that aren't.
const EXT: Record<string, string> = {
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objective-c", mm: "objective-cpp",
  htm: "html", xhtml: "html", svg: "xml", plist: "xml", xsd: "xml", csproj: "xml",
  zsh: "bash", ksh: "bash", command: "bash", ps1: "powershell", psm1: "powershell", cmd: "bat",
  ex: "elixir", exs: "elixir", kt: "kotlin", kts: "kotlin", gradle: "groovy", rake: "ruby", gemspec: "ruby",
  tf: "terraform", tfvars: "terraform", pl: "perl", pm: "perl", hs: "haskell", ml: "ocaml", fs: "fsharp",
  conf: "ini", cfg: "ini", editorconfig: "ini", gitconfig: "ini", gitmodules: "ini", properties: "properties",
  lock: "json", webmanifest: "json", map: "json", jsonl: "json", ipynb: "json", "code-workspace": "jsonc",
  patch: "diff", markdown: "markdown", tex: "latex", sol: "solidity", proto: "proto", gql: "graphql",
};
// Whole names, lower case. Checked before the ending.
const NAME: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", justfile: "makefile",
  "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby", podfile: "ruby", brewfile: "ruby", vagrantfile: "ruby",
  "cargo.lock": "toml", "poetry.lock": "toml", "uv.lock": "toml", "pnpm-lock.yaml": "yaml", "yarn.lock": "yaml", "gemfile.lock": "",
  "bun.lock": "jsonc", "tsconfig.json": "jsonc", "jsconfig.json": "jsonc", ".eslintrc": "jsonc", ".babelrc": "jsonc", ".prettierrc": "json",
  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".bash_profile": "bash", ".zprofile": "bash",
  ".gitconfig": "ini", ".gitmodules": "ini", ".editorconfig": "ini", ".npmrc": "ini", ".htaccess": "apache", "nginx.conf": "nginx",
  codeowners: "codeowners", artisan: "php", caddyfile: "",
};
const known = (lang: string | undefined): BundledLanguage | null => (lang && lang in bundledLanguages ? (lang as BundledLanguage) : null);

/// The language to colour `path` as, from its name. Null when there's no telling.
export function langFor(path: string): BundledLanguage | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base in NAME) return known(NAME[base]);
  if (base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return known("dockerfile");
  // ".env", ".env.local", "prod.env"
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) return known("dotenv");
  // Two-part endings that mean more than their last part.
  if (base.endsWith(".blade.php")) return known("blade");
  if (base.endsWith(".d.ts")) return known("typescript");
  if (!base.includes(".")) return null;
  const ext = base.split(".").pop()!;
  return known(EXT[ext]) ?? known(ext);
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
