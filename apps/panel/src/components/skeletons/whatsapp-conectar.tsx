/**
 * «Conectar WhatsApp» (`routes/whatsapp.conectar.tsx`): la explicación, los dos
 * orígenes del número y el botón de Facebook. El marco es el `AuthSplit` real,
 * con sus enlaces legales (`AuthLegal`, solo enlaces).
 */
import { Skeleton } from "@odentia/ui"
import { AuthAside, AuthSplit, SkeletonRegion } from "@odentia/ui-patterns"
import { AuthLegal } from "../../lib/auth-screens"
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
    <AuthSplit
      title="Conectar WhatsApp"
      aside={<AuthAside tag="WhatsApp" title="Tu clínica" accent="conecta su número." />}
      legal={<AuthLegal />}
    >
      <WhatsAppConnectSkeleton />
    </AuthSplit>
  )
}
