import type { ComponentProps } from "react";
import { cn } from "@odentia/ui";

export type ChipVariant = "neutral" | "success" | "warning" | "danger";

const chipVariants: Record<ChipVariant, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-700",
};

export interface ChipProps extends ComponentProps<"span"> {
  variant?: ChipVariant;
}

export function Chip({ variant = "neutral", className, ...props }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium",
        chipVariants[variant],
        className,
      )}
      {...props}
    />
  );
}
