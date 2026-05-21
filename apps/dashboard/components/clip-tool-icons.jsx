/**
 * Custom Lucide-style icons for clip quick tools.
 * Location: apps/dashboard/components/clip-tool-icons.jsx
 */

export function ExtractStemsIcon({ size = 24, strokeWidth = 2, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="4.5" r="2.25" />
      <path d="M3.75 12.25H20.25V16.25L14.75 20V22L9.25 23.25V20L3.75 16.25Z" />
    </svg>
  );
}

export function FitToTempoIcon({ size = 24, strokeWidth = 2, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 12H9" />
      <path d="M6.75 9.5L9.25 12L6.75 14.5" />
      <circle cx="16" cy="12" r="5.25" />
      <path d="M16 9.25V12H18.5" />
    </svg>
  );
}
