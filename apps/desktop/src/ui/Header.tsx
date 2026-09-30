import { repoName } from "../lib/api";
import { navigate, type Route } from "../lib/routes";
import { openInNewWindow } from "../lib/windows";
import { useState } from "react";
import { NewWindowIcon, ThemeIcon } from "./icons";
import { getTheme, setTheme, THEMES, type Theme } from "../lib/theme";

export function Header({ route, right }: { route: Route; right?: React.ReactNode }) {
  const crumb = "text-stone-500 hover:text-stone-800 dark:hover:text-stone-200";
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-stone-300 bg-white px-4 dark:border-stone-700 dark:bg-stone-800">
      <span className="h-[18px] w-[18px] rounded bg-teal-700" />
      <span className="mr-2 text-body font-semibold">Pando</span>
      {route.kind !== "repos" && (
        <>
          <button onClick={() => navigate({ kind: "repos" })} className={crumb}>‹ Repositories</button>
          <span className="text-stone-400">/</span>
          {route.kind === "repo" ? (
            <span className="font-mono text-body font-medium">{repoName(route.root)}</span>
          ) : (
            <button onClick={() => navigate({ kind: "repo", root: route.root })} className={`${crumb} font-mono text-body`}>{repoName(route.root)}</button>
          )}
          {route.kind === "worktree" && (<><span className="text-stone-400">/</span><span className="font-mono text-body font-medium">{route.path.split(/[\\/]/).pop()}</span></>)}
          {route.kind === "branch" && (<><span className="text-stone-400">/</span><span className="font-mono text-body font-medium">{route.name}</span></>)}
          {route.kind === "commit" && (<><span className="text-stone-400">/</span><span className="font-mono text-body font-medium">{route.id.slice(0, 7)}</span></>)}
        </>
      )}
      <div className="grow" />
      {right}
      <ThemeButton />
      <button onClick={() => openInNewWindow(route).catch(() => {})} title="Open this screen in a new window" aria-label="Open in new window" className="flex items-center rounded-md px-2.5 py-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-200">
        <NewWindowIcon />
      </button>
    </header>
  );
}

const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Auto" };

/// Cycles Light → Dark → Auto.
function ThemeButton() {
  const [theme, set] = useState<Theme>(getTheme);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  return (
    <button
      onClick={() => { setTheme(next); set(next); }}
      title={`Appearance: ${LABEL[theme]}. Click for ${LABEL[next]}.`}
      aria-label={`Appearance: ${LABEL[theme]}`}
      className="flex items-center rounded-md px-2.5 py-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-200"
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}
