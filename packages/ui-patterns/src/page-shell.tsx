import * as React from "react";

export interface PageShellProps {
  children: React.ReactNode;
  className?: string;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "full";
}

const maxWidthClasses: Record<NonNullable<PageShellProps["maxWidth"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  full: "max-w-none",
};

/**
 * Shell centrado para auth/launcher; respeta tokens de spacing (p-4/5/6 → page-padding 24px)
 * y background de DESIGN.md. Para layout con sidebar 216px, usar Sidebar oficial shadcn/Base UI
 * en la app; este PageShell es el contenedor mínimo compartido.
 */
export function PageShell({ children, className, maxWidth = "md" }: PageShellProps) {
  return (
    <div
      className={[
        "flex min-h-full items-center justify-center bg-background p-4 sm:p-5 md:p-6",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={["w-full", maxWidthClasses[maxWidth]].join(" ")}>{children}</div>
    </div>
  );
}
