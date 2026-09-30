/// "Open in new window": two overlapping windows.
export function NewWindowIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="13" height="13" rx="2" />
      <path d="M3 11h13" />
      <path d="M8 4h11a2 2 0 0 1 2 2v11" />
    </svg>
  );
}

/// Sun, moon, or half-filled circle for "follow the system".
export function ThemeIcon({ theme, size = 14 }: { theme: "system" | "light" | "dark"; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;
  if (theme === "light") return <svg {...p}><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" strokeLinecap="round" /></svg>;
  if (theme === "dark") return <svg {...p}><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" strokeLinejoin="round" /></svg>;
  return <svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none" /></svg>;
}
