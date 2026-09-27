type Tone = "grey" | "amber" | "teal" | "red";

const tones: Record<Tone, string> = {
  grey: "bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200",
  red: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
};

export function Chip({ tone = "grey", mono, children }: { tone?: Tone; mono?: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-body ${mono ? "font-mono" : ""} ${tones[tone]}`}>
      {children}
    </span>
  );
}
