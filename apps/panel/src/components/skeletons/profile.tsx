/**
 * Mi perfil (`routes/_app/profile.tsx`): lo que no depende de datos va con su
 * texto; las sesiones, las clínicas y la verificación en dos pasos se cargan por
 * separado y cada una tiene su pieza.
 */
import { Button, Separator, Skeleton } from "@odentia/ui"
import { useKnownStaffRecord } from "../../lib/admin-access"
import { PageLoading, TextSm, TextXs } from "./page-loading"

export function SessionsSkeleton() {
  return (
    <ul className="flex flex-col gap-3">
      {[0, 1].map((row) => (
        <li key={row} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
          <Skeleton className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <TextSm className="w-36" />
            <TextXs className="w-56" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ClinicsSkeleton() {
  return (
    <ul className="flex flex-col gap-3">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
          <div className="min-w-0">
            <TextSm className="w-40" />
            <TextXs className="w-24" />
          </div>
          <span className="ml-auto flex gap-2">
            <Skeleton className="h-8 w-16 rounded-3xl" />
            <Skeleton className="h-8 w-14 rounded-3xl" />
          </span>
        </li>
      ))}
    </ul>
  )
}

export function TwoFactorSkeleton() {
  // El personal no la activa aquí: la pantalla le dice que se maneja en la administración, sin botón.
  if (useKnownStaffRecord()) {
    return (
      <div className="flex flex-col gap-1">
        <TextSm className="w-52" />
        <TextSm className="w-72" />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex max-w-md flex-1 flex-col gap-1">
        <TextSm className="w-52" />
        <TextSm className="w-full" />
        <TextSm className="w-3/4" />
      </div>
      <Skeleton className="h-9 w-24 shrink-0 rounded-3xl" />
    </div>
  )
}

function CardTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-heading text-base font-medium">{title}</div>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function ProfilePageSkeleton() {
  return (
    <PageLoading
      title="Mi perfil"
      subtitle="Administra tu información de cuenta y seguridad"
      className="flex max-w-2xl flex-col gap-6"
      bodyClassName="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Perfil</div>
          <TextSm className="w-64" />
        </div>
        <div>
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <TextSm className="w-32" />
              <TextSm className="w-44" />
            </div>
            <Skeleton className="ml-auto h-8 w-24 shrink-0 rounded-3xl" />
          </div>
          <Separator className="my-2" />
          <div className="flex items-center justify-between py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Nombre</p>
              <TextSm className="w-40" />
            </div>
            <Button type="button" variant="outline" size="sm" disabled>
              Editar
            </Button>
          </div>
          <div className="flex items-center justify-between py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Correo</p>
              <TextSm className="w-48" />
            </div>
            <Button type="button" variant="outline" size="sm" disabled>
              Cambiar
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <CardTitle title="Seguridad" description="Tu contraseña y la verificación en dos pasos." />
        <div>
          <Button type="button" variant="outline" disabled>
            Cambiar contraseña
          </Button>
        </div>
        <Separator />
        <TwoFactorSkeleton />
      </div>
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <CardTitle title="Sesiones activas" description="Dispositivos con acceso a tu cuenta." />
        <div>
          <SessionsSkeleton />
        </div>
      </div>
      <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
        <CardTitle title="Mis clínicas" description="Clínicas a las que perteneces y tu rol en cada una." />
        <ClinicsSkeleton />
      </div>
      <div className="flex flex-col gap-6 elevated rounded-xl border border-destructive/30 bg-card p-6">
        <CardTitle
          title="Cerrar cuenta"
          description="Sales de tus clínicas y se bloquea tu acceso. Tu trabajo previo conserva tu autoría. Si eres la única propietaria de alguna clínica, nombra antes a otra persona."
        />
        <div>
          <Button type="button" variant="destructive" disabled>
            Cerrar mi cuenta
          </Button>
        </div>
      </div>
    </PageLoading>
  )
}
