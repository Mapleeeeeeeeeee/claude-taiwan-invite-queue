export interface ClaudeSparkLogoProps {
  size?: number;
  className?: string;
}

export function ClaudeSparkLogo({
  size = 20,
  className = '',
}: ClaudeSparkLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M4.5 10.5C3.67 10.5 3 11.17 3 12s.67 1.5 1.5 1.5h3.88l-2.74 2.74c-.59.59-.59 1.54 0 2.12.59.59 1.54.59 2.12 0L10.5 15.62V19.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-3.88l2.74 2.74c.59.59 1.54.59 2.12 0 .59-.59.59-1.54 0-2.12L15.62 13.5H19.5c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5h-3.88l2.74-2.74c.59-.59.59-1.54 0-2.12-.59-.59-1.54-.59-2.12 0L13.5 8.38V4.5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v3.88L7.76 5.64c-.59-.59-1.54-.59-2.12 0-.59.59-.59 1.54 0 2.12l2.74 2.74H4.5z" />
    </svg>
  );
}
