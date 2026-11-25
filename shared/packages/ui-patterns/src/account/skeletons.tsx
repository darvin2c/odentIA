/**
 * Lo que se carga por separado dentro de las pantallas de la cuenta (las sesiones, la
 * verificación en dos pasos y los casos de soporte), con las mismas rejillas que lo real. El
 * esqueleto de la página entera lo pone cada app en su ruta (`components/skeletons/`).
 */
import { cn, Skeleton } from "@odentia/ui"

/** Una línea de `text-sm` (20 px de alto). */
export function AccountTextSm({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-4 max-w-full", className)} />
}

/** Una línea de `text-xs` (16 px de alto). */
export function AccountTextXs({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-3 max-w-full", className)} />
}

export function SessionsSkeleton() {
  return (
    <ul className="flex flex-col gap-3">
      {[0, 1].map((row) => (
        <li key={row} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
          <Skeleton className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <AccountTextSm className="w-36" />
            <AccountTextXs className="w-56" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** `staff`: el personal no la activa aquí; la pantalla le dice que se maneja en la administración, sin botón. */
export function TwoFactorSkeleton({ staff = false }: { staff?: boolean }) {
  if (staff) {
    return (
      <div className="flex flex-col gap-1">
        <AccountTextSm className="w-52" />
        <AccountTextSm className="w-72" />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex max-w-md flex-1 flex-col gap-1">
        <AccountTextSm className="w-52" />
        <AccountTextSm className="w-full" />
        <AccountTextSm className="w-3/4" />
      </div>
      <Skeleton className="h-9 w-24 shrink-0 rounded-3xl" />
    </div>
  )
}

export function AccountCasesSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5">
          <span className="flex w-full flex-wrap items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <AccountTextSm className="w-40" />
          </span>
          <AccountTextSm className="w-3/4" />
          <Skeleton className="h-11 w-24 self-start rounded-3xl sm:h-9" />
        </li>
      ))}
    </ul>
  )
}

/** Lo que va bajo «← Todos los casos»: la consulta, los mensajes y la respuesta. */
export function AccountCaseSkeleton() {
  return (
    <>
      <AccountTextSm className="w-3/4" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-3/4 max-w-[92%] self-end rounded-2xl rounded-br-md" />
        <Skeleton className="h-20 w-4/5 max-w-[92%] self-start rounded-2xl rounded-bl-md" />
        <Skeleton className="h-11 w-2/3 max-w-[92%] self-end rounded-2xl rounded-br-md" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="flex flex-col gap-1 text-sm font-semibold">
          Tu respuesta
          <Skeleton className="h-[60px] w-full rounded-md" />
        </span>
        <Skeleton className="h-11 w-20 self-start rounded-3xl sm:h-9" />
      </div>
    </>
  )
}
