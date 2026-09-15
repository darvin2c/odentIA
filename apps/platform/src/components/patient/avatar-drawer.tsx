import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldLabel, Input, Slider } from "@odentia/ui";
import { FormDrawer } from "@odentia/ui-patterns";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { API_URL } from "../../lib/auth-client";
import { orgSlugFromHostname } from "../../lib/host";

async function croppedAvatar(source: string, area: Area): Promise<Blob> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No se pudo preparar el recorte.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 512, 512);
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, 512, 512);
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo generar la imagen.")), "image/jpeg", 0.9);
  return promise;
}

export function AvatarDrawer({ patientId, open, onOpenChange }: { patientId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pending, setPending] = useState(false);
  const [canSave, setCanSave] = useState(false);
  const submitRef = useRef<() => void>(() => {});
  return (
    <FormDrawer
      open={open}
      onClose={() => { if (!pending) onOpenChange(false); }}
      title="Foto del paciente"
      description="Elige un archivo o usa la cámara. Ajusta el recorte cuadrado antes de guardar."
      onSubmit={(event) => {
        event.preventDefault();
        submitRef.current();
      }}
      isSubmitting={pending}
      submitDisabled={!canSave}
      submitLabel="Guardar foto"
      className="sm:max-w-xl"
    >
      {open && (
        <AvatarEditor
          patientId={patientId}
          onPending={setPending}
          onCanSave={setCanSave}
          registerSubmit={(submit) => {
            submitRef.current = submit;
          }}
        />
      )}
    </FormDrawer>
  );
}

function AvatarEditor({
  patientId,
  onPending,
  onCanSave,
  registerSubmit,
}: {
  patientId: string;
  onPending: (pending: boolean) => void;
  onCanSave: (canSave: boolean) => void;
  registerSubmit: (submit: () => void) => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [source, setSource] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraPending, setCameraPending] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => {
    if (source?.startsWith("blob:")) return () => URL.revokeObjectURL(source);
  }, [source]);
  useEffect(() => {
    if (stream && video.current) video.current.srcObject = stream;
    return () => { stream?.getTracks().forEach((track) => track.stop()); };
  }, [stream]);
  const cropComplete = useCallback((_percent: Area, pixels: Area) => setArea(pixels), []);
  const chooseSource = (value: string) => {
    request.current += 1;
    setStream(null); setCameraPending(false); setVideoReady(false);
    setSource(value); setCrop({ x: 0, y: 0 }); setZoom(1); setArea(null); setError(null);
    save.reset();
  };
  const startCamera = async () => {
    const ticket = ++request.current;
    setError(null); setStream(null); setSource(null); setCameraPending(true); setVideoReady(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Cámara no disponible.");
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      if (ticket !== request.current) { next.getTracks().forEach((track) => track.stop()); return; }
      setStream(next);
    } catch {
      if (ticket === request.current) setError("No se pudo acceder a la cámara. Revisa el permiso del navegador o elige un archivo.");
    } finally {
      if (ticket === request.current) setCameraPending(false);
    }
  };
  const capture = () => {
    const element = video.current;
    if (!element?.videoWidth || !element?.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth; canvas.height = element.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) { setError("No se pudo capturar la imagen."); return; }
    context.drawImage(element, 0, 0);
    chooseSource(canvas.toDataURL("image/jpeg", 0.95));
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!source || !area) throw new Error("Selecciona una imagen y ajusta el recorte.");
      const file = await croppedAvatar(source, area);
      const form = new FormData(); form.append("file", file, "avatar.jpg");
      const slug = orgSlugFromHostname(window.location.hostname);
      const response = await fetch(`${API_URL}/api/patients/${patientId}/avatar`, { method: "POST", credentials: "include", headers: slug ? { "x-odentia-org": slug } : {}, body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `No se pudo guardar la foto (${response.status}).`);
      }
    },
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["patient-avatar", patientId] }), queryClient.invalidateQueries({ queryKey: ["patient", patientId] })]);
    },
  });
  useEffect(() => { onPending(save.isPending); return () => onPending(false); }, [save.isPending, onPending]);
  useEffect(() => { onCanSave(Boolean(source && area)); return () => onCanSave(false); }, [source, area, onCanSave]);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => { registerSubmit(() => saveRef.current.mutate()); }, [registerSubmit]);
  return <div className="flex flex-col gap-4">
    <Field><FieldLabel htmlFor={`${id}-file`}>Archivo de imagen</FieldLabel><Input id={`${id}-file`} type="file" accept="image/jpeg,image/png,image/webp" disabled={save.isPending} onChange={(event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("Elige una imagen JPG, PNG o WebP."); return; }
      chooseSource(URL.createObjectURL(file));
    }} /></Field>
    <div><Button type="button" variant="outline" disabled={save.isPending || cameraPending} onClick={() => void startCamera()}>{cameraPending ? "Abriendo cámara…" : "Usar cámara"}</Button></div>
    {stream && <div className="flex flex-col gap-2"><video ref={video} autoPlay muted playsInline onLoadedData={() => setVideoReady(true)} className="max-h-80 w-full rounded-lg bg-black" aria-label="Vista previa de cámara" /><Button type="button" onClick={capture} disabled={!videoReady}>Capturar</Button></div>}
    {source && <>
      <div className="relative h-80 overflow-hidden rounded-lg bg-muted" aria-label="Editor de recorte"><Cropper image={source} crop={crop} zoom={zoom} aspect={1} onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={cropComplete} cropperProps={{ "aria-label": "Arrastra para ajustar el recorte" }} /></div>
      <Field><FieldLabel htmlFor={`${id}-zoom`}>Zoom</FieldLabel><Slider id={`${id}-zoom`} aria-label="Zoom de la foto" value={[zoom]} min={1} max={3} step={0.05} disabled={save.isPending} onValueChange={(value) => setZoom(Array.isArray(value) ? value[0] ?? 1 : value)} /></Field>
    </>}
    {(error || save.isError) && <p role="alert" className="text-sm text-destructive">{error ?? save.error?.message}</p>}
  </div>;
}
