/** Soporte de la cuenta (`routes/_app/support.tsx`): pedir ayuda, tus casos y la conversación. */
import { Button, Skeleton } from "@odentia/ui"
import { PageLoading, TextSm } from "./page-loading"

export function AccountCasesSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5">
          <span className="flex w-full flex-wrap items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <TextSm className="w-40" />
          </span>
          <TextSm className="w-3/4" />
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
      <TextSm className="w-3/4" />
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

export function AccountSupportPageSkeleton() {
  return (
    <PageLoading title="Soporte" subtitle="Problemas para entrar a tu cuenta y seguimiento de tus casos.">
      <section className="flex flex-col gap-2 rounded-xl border px-3 py-3">
        <h2 className="text-sm font-bold">¿No puedes entrar a una clínica?</h2>
        <p className="text-sm text-muted-foreground">
          Cuéntalo aquí aunque no tengas organización abierta. Solo te pedimos lo necesario para ayudarte.
        </p>
        <span className="flex flex-col gap-1 text-sm font-semibold">
          Qué pasa
          <Skeleton className="h-[76px] w-full rounded-md" />
        </span>
        <span className="flex flex-col gap-1 text-sm font-semibold">
          Detalle (opcional)
          <Skeleton className="h-11 w-full rounded-md" />
        </span>
        <Button type="button" className="min-h-11 self-start sm:min-h-9" disabled>
          Enviar a soporte
        </Button>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold">Tus casos</h2>
        <AccountCasesSkeleton />
      </section>
    </PageLoading>
  )
}
