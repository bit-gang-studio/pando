import { api, type Branch } from "./api";
import { confirm } from "../ui/Confirm";
import { withToast } from "../ui/Toast";

const SHOWN = 5;

/// Ask, then make the branch's upstream match it. Names the commits on the
/// remote that will be replaced. True if it pushed.
export async function forcePush(root: string, b: Branch): Promise<boolean> {
  if (!b.upstream) return false;
  // What the remote has that this branch doesn't: the commits that go.
  const gone = await api.log(root, `${b.name}..${b.upstream}`, 0, SHOWN + 1).catch(() => null);
  const list = gone?.entries ?? [];
  const more = (b.behind ?? list.length) - Math.min(list.length, SHOWN);
  const a = await confirm({
    title: "Force push",
    action: "Force push",
    danger: true,
    body: (
      <>
        <span className="font-mono">{b.upstream}</span> will match <span className="font-mono">{b.name}</span>. You rewrote {b.behind === 1 ? "a commit" : "commits"} that {b.behind === 1 ? "is" : "are"} already there, so {b.behind === 1 ? "this one is" : "these are"} replaced:
        <span className="mt-2 flex flex-col gap-0.5">
          {list.slice(0, SHOWN).map((e) => (
            <span key={e.id} className="truncate"><span className="font-mono text-stone-500">{e.id.slice(0, 7)}</span> {e.summary} <span className="text-stone-500">· {e.author}</span></span>
          ))}
          {more > 0 && <span className="text-stone-500">and {more} more</span>}
        </span>
        <span className="mt-2 block">Anyone else using this branch will have to reset to it.</span>
      </>
    ),
  });
  if (!a.ok) return false;
  return (await withToast(`Force pushing ${b.name}…`, `Force pushed ${b.name}`, () => api.branchForcePush(root, b.name).then(() => true))) === true;
}
