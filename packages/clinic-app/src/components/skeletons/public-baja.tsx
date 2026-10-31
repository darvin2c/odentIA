/**
 * Las dos bajas por enlace (`routes/public/baja.$token.tsx` y
 * `routes/public/resumen-lunes.baja.$token.tsx`): el mismo `PageHeader`, lo que
 * explica y un botón. Su título ya se sabe; lo que explica lo dice el servidor.
 */
import { Button, Skeleton } from "@odentia/ui"
import { PageHeader, PageShell, SkeletonRegion } from "@odentia/ui-patterns"

function Explanation() {
  return (
    <div className="flex w-full flex-col">
      <Skeleton className="my-0.5 h-4 w-full" />
      <Skeleton className="my-0.5 h-4 w-3/4" />
    </div>
  )
}

function UnsubscribeBody({ title, action, message }: { title: string; action: string; message: string }) {
  return (
    <SkeletonRegion message={message}>
      <PageHeader title={title} subtitle={<Explanation />} />
      <div className="mt-6">
        <Button type="button" className="min-h-11 w-full" disabled>
          {action}
        </Button>
      </div>
    </SkeletonRegion>
  )
}

export function BajaSkeleton() {
  return (
    <UnsubscribeBody
      title="Dejar de recibir estos mensajes"
      action="Confirmar baja"
      message="Cargando la solicitud de baja…"
    />
  )
}

export function BajaPageSkeleton() {
  return (
    <PageShell maxWidth="md">
      <BajaSkeleton />
    </PageShell>
  )
}

export function DigestStopSkeleton() {
  return (
    <UnsubscribeBody
      title="Dejar de recibir el resumen del lunes"
      action="Dejar de recibirlo"
      message="Abriendo el enlace…"
    />
  )
}

export function DigestStopPageSkeleton() {
  return (
    <PageShell maxWidth="md">
      <DigestStopSkeleton />
    </PageShell>
  )
}
