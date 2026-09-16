import { cn } from "@odentia/ui";
import * as React from "react";

export interface PageShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Shell centrado para auth/launcher; respeta tokens de spacing (p-4/5/6 → page-padding 24px)
 * y background de DESIGN.md. Para layout con sidebar 216px, usar Sidebar oficial shadcn/Base UI
 * en la app; este PageShell es el contenedor mínimo compartido.
 */
export function PageShell({ children, className }: PageShellProps) {
  return (
    <div className={cn("bg-muted p-6 h-full", className)}>
      {children}
    </div>
  );
}
