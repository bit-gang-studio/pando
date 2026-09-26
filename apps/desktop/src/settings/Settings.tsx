import { useEffect, useState } from "react";
import { api, repoName, type RepoConfig, type UserConfig } from "../lib/api";

type Tab = "general" | "hooks" | "runtime" | "agents" | "land" | "editor";
const TABS: { id: Tab; label: string; group: "repo" | "you" }[] = [
  { id: "general", label: "General", group: "repo" },
  { id: "hooks", label: "Setup hooks", group: "repo" },
  { id: "runtime", label: "Runtime", group: "repo" },
  { id: "agents", label: "Agents and launchers", group: "repo" },
  { id: "land", label: "Land defaults", group: "repo" },
  { id: "editor", label: "Editor", group: "you" },
];

const input = "h-8 rounded-md border border-stone-300 bg-white px-2.5 font-mono text-xs focus:border-teal-700 focus:outline-none dark:border-stone-600 dark:bg-stone-700";
const btn = "h-7 rounded-md border border-stone-300 bg-white px-2.5 text-xs hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:bg-stone-700";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-stone-300 bg-white p-4 dark:border-stone-700 dark:bg-stone-800">
      <div className="font-semibold">{title}</div>
      {hint && <div className="text-xs text-stone-500">{hint}</div>}
      {children}
    </section>
  );
}

function CommandList({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-5 font-mono text-xs text-stone-400">{i + 1}</span>
          <input value={c} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} placeholder={placeholder} className={`${input} grow`} />
          <button aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))} className={`${btn} w-7`}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...items, ""])} className="self-start rounded-md border border-dashed border-stone-400 px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-700">+ Add command</button>
    </div>
  );
}

export function Settings({ root, userConfig, onUserConfig }: { root: string; userConfig: UserConfig; onUserConfig: (c: UserConfig) => void }) {
  const [tab, setTab] = useState<Tab>("hooks");
  const [cfg, setCfg] = useState<RepoConfig | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [toml, setToml] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState(userConfig.editor ?? "");

  useEffect(() => {
    api.configLoad(root).then((c) => { setCfg(c); api.configRender(c).then((t) => { setToml(t); setSaved(t); }); }).catch((e) => setError(String(e)));
  }, [root]);

  useEffect(() => {
    if (!cfg) return;
    const t = setTimeout(() => api.configRender(cfg).then(setToml).catch((e) => setError(String(e))), 150);
    return () => clearTimeout(t);
  }, [cfg]);

  const dirty = toml !== saved;

  async function save() {
    if (!cfg) return;
    try { const t = await api.configSave(root, cfg); setSaved(t); setToml(t); setStatus("Saved .pando.toml"); setError(null); }
    catch (e) { setError(String(e)); }
  }
  async function commit() {
    await save();
    try { await api.configCommit(root); setStatus("Committed .pando.toml on the main worktree"); }
    catch (e) { setError(String(e)); }
  }
  async function saveEditor() {
    const next = { ...userConfig, editor: editor.trim() || null };
    try { await api.userConfigSave(next); onUserConfig(next); setStatus("Saved editor"); }
    catch (e) { setError(String(e)); }
  }

  const up = (patch: (c: RepoConfig) => RepoConfig) => setCfg((c) => (c ? patch(structuredClone(c)) : c));

  return (
    <div className="flex min-h-0 grow">
      <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-stone-300 bg-stone-200/70 p-3 dark:border-stone-700 dark:bg-stone-900">
        <div className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-stone-500">REPOSITORY</div>
        {TABS.filter((t) => t.group === "repo").map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-md px-2 py-1.5 text-left ${tab === t.id ? "bg-white font-medium dark:bg-stone-700" : "hover:bg-white/60 dark:hover:bg-stone-800"}`}>{t.label}</button>
        ))}
        <div className="px-2 pb-1 pt-4 text-[11px] font-semibold tracking-wider text-stone-500">YOU</div>
        {TABS.filter((t) => t.group === "you").map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-md px-2 py-1.5 text-left ${tab === t.id ? "bg-white font-medium dark:bg-stone-700" : "hover:bg-white/60 dark:hover:bg-stone-800"}`}>{t.label}</button>
        ))}
      </nav>

      <main className="flex min-w-0 grow flex-col gap-4 overflow-y-auto p-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">{TABS.find((t) => t.id === tab)?.label}</h1>
          <span className="text-stone-500">{repoName(root)}</span>
          <div className="grow" />
          {status && <span className="text-xs text-teal-700">{status}</span>}
        </div>
        {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>}

        {cfg && tab === "general" && (
          <>
            <Section title="Workspace location" hint="Template for new worktrees. {repo}, {branch} and {branch_slug} expand. A leading ~ is your home. Relative paths are relative to the repo root.">
              <input value={cfg.workspace.location} onChange={(e) => up((c) => { c.workspace.location = e.target.value; return c; })} className={input} />
            </Section>
            <Section title="Default base" hint="Start point for new branches. Empty means the repo's default branch.">
              <input value={cfg.workspace.base ?? ""} onChange={(e) => up((c) => { c.workspace.base = e.target.value || null; return c; })} placeholder="origin/main" className={input} />
            </Section>
          </>
        )}

        {cfg && tab === "hooks" && (
          <>
            <Section title="After create" hint="Run in order in the new worktree. Stops on the first failure. Hooks get PORT, PANDO_MAIN, PANDO_BRANCH and PANDO_WORKSPACE.">
              <CommandList items={cfg.hooks.post_create} onChange={(v) => up((c) => { c.hooks.post_create = v; return c; })} placeholder="pnpm install --prefer-offline" />
            </Section>
            <Section title="Before land" hint="Must pass before Land continues.">
              <CommandList items={cfg.hooks.pre_land} onChange={(v) => up((c) => { c.hooks.pre_land = v; return c; })} placeholder="pnpm test" />
            </Section>
            <Section title="After land">
              <CommandList items={cfg.hooks.post_land} onChange={(v) => up((c) => { c.hooks.post_land = v; return c; })} placeholder="" />
            </Section>
          </>
        )}

        {cfg && tab === "runtime" && (
          <>
            <Section title="Port per workspace" hint="Each workspace gets its own port, exported to hooks and launchers.">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!cfg.runtime.port} onChange={(e) => up((c) => { c.runtime.port = e.target.checked ? { env: "PORT", start: 3000 } : null; return c; })} /> Assign ports</label>
              {cfg.runtime.port && (
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-2">Env var <input value={cfg.runtime.port.env} onChange={(e) => up((c) => { c.runtime.port!.env = e.target.value; return c; })} className={`${input} w-32`} /></label>
                  <label className="flex items-center gap-2">Start at <input type="number" value={cfg.runtime.port.start} onChange={(e) => up((c) => { c.runtime.port!.start = Number(e.target.value) || 3000; return c; })} className={`${input} w-24`} /></label>
                </div>
              )}
            </Section>
            <Section title="Share between workspaces" hint="Copied from the main worktree with copy-on-write where the filesystem allows. Not wired into create yet.">
              <CommandList items={cfg.runtime.share} onChange={(v) => up((c) => { c.runtime.share = v; return c; })} placeholder="node_modules" />
            </Section>
          </>
        )}

        {cfg && tab === "agents" && (
          <Section title="Agents" hint="Name and command. The command runs in the workspace with PORT set. Launching from the app lands with the M4 launchers card.">
            <div className="flex flex-col gap-1.5">
              {Object.entries(cfg.agents).map(([name, a]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-24 truncate font-mono text-xs">{name}</span>
                  <input value={a.command} onChange={(e) => up((c) => { c.agents[name] = { command: e.target.value }; return c; })} className={`${input} grow`} />
                  <button aria-label="Remove" onClick={() => up((c) => { delete c.agents[name]; return c; })} className={`${btn} w-7`}>×</button>
                </div>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; const n = (f.elements.namedItem("n") as HTMLInputElement).value.trim(); const cmd = (f.elements.namedItem("c") as HTMLInputElement).value.trim(); if (!n) return; up((c) => { c.agents[n] = { command: cmd || n }; return c; }); f.reset(); }} className="flex items-center gap-2">
                <input name="n" placeholder="claude" className={`${input} w-24`} />
                <input name="c" placeholder="claude --worktree" className={`${input} grow`} />
                <button type="submit" className={btn}>Add</button>
              </form>
            </div>
          </Section>
        )}

        {cfg && tab === "land" && (
          <Section title="Land defaults" hint="What the Land dialog starts with. You can change them per land.">
            <label className="flex items-center gap-2 text-xs">Strategy
              <select value={cfg.land.strategy} onChange={(e) => up((c) => { c.land.strategy = e.target.value; return c; })} className={`${input} w-32`}>
                <option value="squash">squash</option><option value="rebase">rebase</option><option value="merge">merge</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.land.remove_worktree} onChange={(e) => up((c) => { c.land.remove_worktree = e.target.checked; return c; })} /> Remove the worktree after landing</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.land.delete_branch} onChange={(e) => up((c) => { c.land.delete_branch = e.target.checked; return c; })} /> Delete the local branch after landing</label>
          </Section>
        )}

        {tab === "editor" && (
          <Section title="Editor" hint="Command used by Open. Examples: code, cursor, zed, idea. Empty uses $VISUAL or $EDITOR, then the system opener. This is yours, not the repo's.">
            <div className="flex items-center gap-2">
              <input value={editor} onChange={(e) => setEditor(e.target.value)} placeholder="code" className={`${input} w-64`} />
              <button onClick={saveEditor} className={btn}>Save</button>
            </div>
          </Section>
        )}
      </main>

      {tab !== "editor" && (
        <aside className="flex w-[400px] shrink-0 flex-col gap-2 border-l border-stone-300 bg-white p-5 dark:border-stone-700 dark:bg-stone-800">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-medium">.pando.toml</span>
            {dirty && <span className="text-xs text-amber-700">unsaved</span>}
            <div className="grow" />
            <button onClick={() => navigator.clipboard.writeText(toml)} className={btn}>Copy</button>
            <button onClick={save} disabled={!dirty} className={btn}>Save</button>
            <button onClick={commit} className="h-7 rounded-md bg-teal-700 px-2.5 text-xs font-medium text-white hover:bg-teal-800">Commit to main</button>
          </div>
          <pre className="grow overflow-auto rounded-lg bg-stone-900 p-3 font-mono text-[12px] leading-[18px] text-stone-100">{toml}</pre>
          <span className="text-xs text-stone-500">Committing shares this setup with everyone who clones the repo.</span>
        </aside>
      )}
    </div>
  );
}
