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
