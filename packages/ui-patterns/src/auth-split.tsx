import { CalendarCheck, MessagesSquare, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

const HIGHLIGHTS = [
  { icon: CalendarCheck, text: "Agenda por profesional, recurso y horario" },
  { icon: MessagesSquare, text: "Bandeja omnicanal con estados por proveedor" },
  { icon: ShieldCheck, text: "Aislamiento total por organización" },
] as const;

/**
 * Layout de autenticación a página completa: branding odentIA ocupa toda la
 * columna izquierda (solo `md:` en adelante; en móvil se oculta y el
 * formulario ocupa todo) con fondo animado por dos blobs que derivan
 * lentamente (CSS puro, sin JS). Columna derecha: formulario centrado.
 */
export function AuthSplit({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-surface-muted md:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-brand-50 md:block">
        <span
          aria-hidden="true"
          className="absolute -left-16 -top-16 size-[28rem] animate-[drift-a_18s_ease-in-out_infinite] motion-reduce:animate-none"
        >
          <span className="block size-full -translate-x-1/4 rounded-full bg-gradient-to-br from-brand-250 via-brand-450 to-primary opacity-40 blur-3xl animate-pulse [animation-duration:6s] motion-reduce:animate-none" />
        </span>
        <span
          aria-hidden="true"
          className="absolute -bottom-20 -right-10 size-[30rem] animate-[drift-b_22s_ease-in-out_infinite] motion-reduce:animate-none"
        >
          <span className="block size-full translate-x-1/4 rounded-full bg-gradient-to-br from-info via-brand-350 to-brand-650 opacity-30 blur-3xl animate-pulse [animation-duration:8s] motion-reduce:animate-none" />
        </span>
        <div className="relative flex h-full flex-col gap-10 p-12">
          <span className="text-xl font-semibold text-foreground">odentIA</span>
          <div className="flex flex-col gap-3">
            <h2 className="max-w-md text-3xl font-semibold tracking-tight text-foreground">
              La operación de tu clínica, en un solo lugar
            </h2>
            <p className="text-sm text-muted-foreground">
              Agenda, pacientes y mensajes aislados por organización.
            </p>
          </div>
          <ul className="mt-auto flex flex-col gap-5">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-foreground">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/70">
                  <Icon className="size-5 text-primary" aria-hidden />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-base leading-snug font-medium">{title}</h1>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <div className="mt-6 flex flex-col gap-4">
            {children}
            {footer ? (
              <div className="text-center text-sm text-muted-foreground">{footer}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
