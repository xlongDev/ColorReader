import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** A quiet, centered empty state used by features that ship in later phases. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn("flex h-full flex-col items-center justify-center px-6 text-center", className)}
    >
      <div className="glass text-text-2 mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
        {icon}
      </div>
      <h2 className="text-text-1 text-base font-semibold">{title}</h2>
      {description && (
        <p className="text-text-2 mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
