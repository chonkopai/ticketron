import { ru } from "@event-platform/shared-types";
import Link from "next/link";

type BackLinkProps = {
  href: string;
  label?: string;
  className?: string;
};

/** Consistent, keyboard-friendly navigation back to the previous section. */
export function BackLink({ href, label = ru.common.back, className = "" }: BackLinkProps) {
  return (
    <Link
      aria-label={label}
      className={`tk-back-link ${className}`}
      href={href}
    >
      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 20 20">
        <path d="m12.5 4.5-5 5 5 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
      <span>{label}</span>
    </Link>
  );
}
