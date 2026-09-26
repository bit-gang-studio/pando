import { repoName, type Board } from "../lib/api";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-stone-300 bg-white p-3 dark:border-stone-700 dark:bg-stone-800">
      <div className="mb-2 font-semibold">{title}</div>
      {children}
    </div>
  );
}

export function RightRail({ boards }: { boards: Board[] }) {
  const ports = boards.flatMap((b) =>
    Object.entries(b.ports).map(([branch, port]) => ({ repo: repoName(b.repo.root), branch, port })),
  );
  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-stone-300 bg-stone-100 p-4 dark:border-stone-700 dark:bg-stone-900">
      <Card title="Overlaps">
        <p className="text-xs text-stone-500">Coming soon. Workspaces editing the same hunks will show here before they conflict.</p>
      </Card>
      <Card title="Runtime">
        {ports.length === 0 ? (
          <p className="text-xs text-stone-500">No ports assigned. Add a <span className="font-mono">[runtime] port</span> to <span className="font-mono">.pando.toml</span>.</p>
        ) : (
          <div className="grid grid-cols-[60px_1fr] gap-x-2 gap-y-1 text-xs">
            {ports.map((p) => (
              <div key={`${p.repo}/${p.branch}`} className="contents">
                <span className="font-mono">:{p.port}</span>
                <span className="truncate">{p.repo} / {p.branch}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </aside>
  );
}
