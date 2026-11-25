/** Soporte de la cuenta (`routes/_app/support.tsx`): pedir ayuda, tus casos y la conversación. */
import { Button, Skeleton } from "@odentia/ui"
import { AccountCasesSkeleton } from "@odentia/ui-patterns"
import { PageLoading } from "./page-loading"

export function AccountSupportPageSkeleton() {
  return (
    <PageLoading
      title="Soporte"
      subtitle="Problemas para entrar a tu cuenta y seguimiento de tus casos."
    >
      <section className="flex flex-col gap-2 rounded-xl border px-3 py-3">
        <h2 className="text-sm font-bold">¿No puedes entrar a una clínica?</h2>
        <p className="text-sm text-muted-foreground">
          Cuéntalo aquí aunque no tengas organización abierta. Solo te pedimos lo necesario para
          ayudarte.
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
