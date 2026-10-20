import { Button } from "@odentia/ui"
import { PersonAvatar } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { AvatarDrawer } from "./avatar-drawer"

export function PatientAvatar({
  patientId,
  name,
  givenNames,
  familyName,
  storageKey,
  size = 80,
}: {
  patientId: string
  name: string
  givenNames?: string | null
  familyName?: string | null
  storageKey?: string | null
  size?: number
}) {
  const canWrite = usePermission("patients.write")
  const canRead = usePermission("patients.read")
  const [open, setOpen] = useState(false)
  const photo = useQuery({
    queryKey: ["patient-avatar", patientId],
    queryFn: () => apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/avatar-url`),
    enabled: canRead && Boolean(storageKey),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const avatar = (
    <span style={{ width: size, height: size }} className="flex shrink-0">
      <PersonAvatar
        name={name}
        givenNames={givenNames}
        familyName={familyName}
        src={photo.data?.data.url}
        className="size-full"
        fallbackClassName="text-2xl"
      />
    </span>
  )
  if (!canWrite) return avatar
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-auto rounded-full p-0"
        aria-label={`Cambiar foto de ${name}`}
        title={photo.isError ? "No se pudo cargar la foto. Haz clic para cambiarla." : "Cambiar foto"}
        onClick={() => setOpen(true)}
      >
        {avatar}
      </Button>
      <AvatarDrawer patientId={patientId} name={name} open={open} onOpenChange={setOpen} />
    </>
  )
}
