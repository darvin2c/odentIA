import { Avatar, AvatarFallback, AvatarImage, Button } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import { AvatarDrawer } from "./avatar-drawer"

export function PatientAvatar({
  patientId,
  name,
  storageKey,
  size = 80,
}: {
  patientId: string
  name: string
  storageKey?: string | null
  size?: number
}) {
  const canWrite = useCanWrite()
  const [open, setOpen] = useState(false)
  const photo = useQuery({
    queryKey: ["patient-avatar", patientId],
    queryFn: () => apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/avatar-url`),
    enabled: Boolean(storageKey),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const avatar = (
    <Avatar style={{ width: size, height: size }}>
      {photo.data && <AvatarImage src={photo.data.data.url} alt={`Foto de ${name}`} />}
      <AvatarFallback>
        {name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((word) => word[0])
          .join("")
          .toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
  if (!canWrite) return avatar
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-auto rounded-full p-0"
        aria-label={`Cambiar foto de ${name}`}
        title={
          photo.isError ? "No se pudo cargar la foto. Haz clic para cambiarla." : "Cambiar foto"
        }
        onClick={() => setOpen(true)}
      >
        {avatar}
      </Button>
      <AvatarDrawer patientId={patientId} open={open} onOpenChange={setOpen} />
    </>
  )
}
