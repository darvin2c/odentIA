/**
 * «Conectar WhatsApp» (`routes/whatsapp.conectar.tsx`): la explicación, los dos
 * orígenes del número y el botón de Facebook, en el marco real de la página
 * (`ConnectLayout`), sin el color de la clínica mientras carga.
 */
import { Skeleton } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { ConnectLayout } from "../whatsapp/connect-layout"
import { TextSm } from "./page-loading"

export function WhatsAppConnectSkeleton() {
  return (
    <SkeletonRegion message="Cargando…" className="flex flex-col gap-4">
      <div className="flex flex-col">
        <TextSm className="w-full" />
        <TextSm className="w-full" />
        <TextSm className="w-2/3" />
      </div>
      <div className="flex flex-col gap-3">
        <TextSm className="w-60" />
        <div className="grid w-full gap-3">
          {[0, 1].map((option) => (
            <div key={option} className="flex w-full items-start gap-3 rounded-xl border p-3">
              <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <TextSm className="w-40" />
                <TextSm className="w-full" />
              </span>
            </div>
          ))}
        </div>
        <Skeleton className="h-11 w-full rounded-3xl" />
      </div>
    </SkeletonRegion>
  )
}

export function WhatsAppConnectPageSkeleton() {
  return (
    <ConnectLayout title="Conectar WhatsApp" clinicName={null} back={null} brandColor={null}>
      <WhatsAppConnectSkeleton />
    </ConnectLayout>
  )
}
