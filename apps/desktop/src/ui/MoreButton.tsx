/// Visible "⋯" that opens the same menu as right-click.
export function MoreButton({ onOpen, label }: { onOpen: (e: React.MouseEvent) => void; label: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen(e); }}
      title="More actions"
      aria-label={label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100"
    >
      ⋯
    </button>
  );
}
