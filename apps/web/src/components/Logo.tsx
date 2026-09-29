export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <rect width="64" height="64" rx="14" fill="var(--accent-700)" />
      <path d="M16 30 32 17l16 13v17a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2z" fill="none" stroke="var(--paper)" strokeWidth="4" strokeLinejoin="round" />
      <circle cx="32" cy="37" r="5" fill="var(--today-500)" />
    </svg>
  );
}
