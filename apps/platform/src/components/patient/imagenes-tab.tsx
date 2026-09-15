import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui";
import { EmptyState, FormDrawer } from "@odentia/ui-patterns";
import { FileText, Image as ImageIcon, Trash2, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { API_URL } from "../../lib/auth-client";
import { timeAgo, useCanWrite } from "../../lib/crm";
import { orgSlugFromHostname } from "../../lib/host";
import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical";
import { type PatientDocument } from "../../lib/patients";

const UPLOAD_CATEGORIES = ["radiografia", "foto_clinica", "consentimiento", "informe", "otro"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  consentimiento: "Consentimiento",
  radiografia: "Radiografía",
  foto_clinica: "Foto clínica",
  informe: "Informe",
  otro: "Otro",
};

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");
const MAX_BYTES = 10 * 1024 * 1024;

/** Las URL firmadas expiran: se consideran frescas 10 min y luego se regeneran. */
const SIGNED_URL_STALE_MS = 10 * 60 * 1000;

const ALL_TEETH = "todas";
const NO_TOOTH = "sin-pieza";

type Dentition = "todas" | "adulta" | "temporal";
const DENTITION_LABELS: Record<Dentition, string> = {
  todas: "Todas",
  adulta: "Adulta",
  temporal: "Temporal",
};

const DENTITIONS: Dentition[] = ["todas", "adulta", "temporal"];

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

function isImageDoc(doc: PatientDocument): boolean {
  return doc.contentType.startsWith("image/");
}

function isPdfDoc(doc: PatientDocument): boolean {
  return doc.contentType === "application/pdf";
}

function useSignedUrl(patientId: string, documentId: string) {
  return useQuery({
    queryKey: ["patient-document-url", patientId, documentId],
    queryFn: () =>
      apiFetch<{ data: { url: string } }>(`/api/patients/${patientId}/documents/${documentId}/url`),
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: 30 * 60 * 1000,
  });
}

export interface ImagenesTabProps {
  patientId: string;
  /** En una atención solo se muestran los documentos vinculados a ella; en perfil, todos. */
  encounterId?: string;
  /** Sincroniza el filtro de pieza (p. ej. al llegar desde el odontograma). */
  initialTooth?: number;
  readOnly?: boolean;
  disabled?: boolean;
  beforeWrite?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  onUploaded?: () => void | Promise<void>;
}

export function ImagenesTab({
  patientId,
  encounterId,
  initialTooth,
  readOnly,
  onUploaded,
  disabled,
  beforeWrite,
  onPendingChange,
}: ImagenesTabProps) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [dentition, setDentition] = useState<Dentition>("todas");
  const [tooth, setTooth] = useState<string>(ALL_TEETH);
  const [viewing, setViewing] = useState<PatientDocument | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const dentitionId = useId();
  const toothId = useId();

  useEffect(() => {
    if (initialTooth == null) return;
    setTooth(String(initialTooth));
    setDentition(FDI_CHILD.includes(initialTooth) ? "temporal" : "adulta");
  }, [initialTooth]);

  const docsQuery = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
  });

  const allDocs = docsQuery.data?.data ?? [];
  // La lista incluye vínculos opcionales a atenciones: en una atención se filtra a sus
  // documentos; en el perfil se listan todos.
  const visibleDocs = encounterId ? allDocs.filter((d) => d.encounterId === encounterId) : allDocs;

  const toothNumber = tooth === ALL_TEETH ? null : Number(tooth);
  const images = visibleDocs.filter(
    (d) =>
      (d.category === "radiografia" || d.category === "foto_clinica") &&
      (toothNumber === null || d.toothNumber === toothNumber),
  );
  const documents = visibleDocs.filter(
    (d) => d.category !== "radiografia" && d.category !== "foto_clinica",
  );

  const dentitionTeeth = dentition === "adulta" ? FDI_ADULT : dentition === "temporal" ? FDI_CHILD : [...FDI_ADULT, ...FDI_CHILD];
  const toothItems: Record<string, string> = {
    [ALL_TEETH]: "Todas las piezas",
    ...Object.fromEntries(dentitionTeeth.map((n) => [String(n), `Pieza ${n}`] as const)),
  };

  const listError =
    docsQuery.error instanceof ApiError
      ? (docsQuery.error.shape.message ?? "No se pudieron cargar los documentos.")
      : docsQuery.error
        ? "No se pudieron cargar los documentos."
        : null;

  const invalidateAfterUpload = async () => {
    await Promise.all(["patient-documents", "timeline", "patient"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key, patientId] }),
    ));
    await onUploaded?.();
  };

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Imágenes" className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Imágenes</h2>
          {!readOnly && canWrite && (
            <Button size="sm" disabled={disabled} onClick={() => setUploadOpen(true)}>
              Subir imagen o documento
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          <Field className="min-w-36 flex-1">
            <FieldLabel htmlFor={dentitionId}>Dentición</FieldLabel>
            <Select
              items={DENTITION_LABELS}
              value={dentition}
              onValueChange={(v) => {
                const next = (v ?? "todas") as Dentition;
                setDentition(DENTITIONS.includes(next) ? next : "todas");
                setTooth(ALL_TEETH);
              }}
            >
              <SelectTrigger id={dentitionId} aria-label="Dentición">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DENTITIONS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {DENTITION_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-36 flex-1">
            <FieldLabel htmlFor={toothId}>Pieza</FieldLabel>
            <Select
              items={toothItems}
              value={toothItems[tooth] ? tooth : ALL_TEETH}
              onValueChange={(v) => setTooth(v ?? ALL_TEETH)}
            >
              <SelectTrigger id={toothId} aria-label="Pieza">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(toothItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {docsQuery.isPending && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {listError && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-destructive">{listError}</p>
            <Button size="sm" variant="outline" onClick={() => void docsQuery.refetch()}>
              Reintentar
            </Button>
          </div>
        )}
        {!docsQuery.isPending && !listError && images.length === 0 && (
          <EmptyState
            title="Sin imágenes"
            description={
              encounterId
                ? "Esta atención aún no tiene imágenes vinculadas."
                : "Aún no hay radiografías ni fotos clínicas."
            }
          />
        )}
        {images.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((doc) => (
              <ImageAttachment key={doc.id} patientId={patientId} doc={doc} onOpen={setViewing} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Documentos" className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Documentos</h2>
        {!docsQuery.isPending && !listError && documents.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin documentos.</p>
        )}
        <div className="flex flex-col gap-2">
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} showEncounter={!encounterId} onOpen={setViewing} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Los documentos se conservan como parte de la historia clínica: no se pueden eliminar.
        </p>
      </section>

      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        {viewing && (
          <DialogContent aria-label={`Ver ${viewing.label}`}>
            <DialogHeader>
              <DialogTitle>{viewing.label}</DialogTitle>
              <DialogDescription>
                {categoryLabel(viewing.category)}
                {viewing.toothNumber != null && ` · Pieza ${viewing.toothNumber}`} ·{" "}
                {timeAgo(viewing.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <DocumentViewer patientId={patientId} doc={viewing} />
          </DialogContent>
        )}
      </Dialog>

      <UploadDrawer
        patientId={patientId}
        encounterId={encounterId}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={invalidateAfterUpload}
        beforeWrite={beforeWrite}
        onPendingChange={onPendingChange}
        disabled={disabled}
      />
    </div>
  );
}

function ImageAttachment({
  patientId,
  doc,
  onOpen,
}: {
  patientId: string;
  doc: PatientDocument;
  onOpen: (doc: PatientDocument) => void;
}) {
  const urlQuery = useSignedUrl(patientId, doc.id);
  const url = urlQuery.data?.data.url ?? null;

  return (
    <li>
      <Attachment orientation="vertical" className="w-full!">
        <AttachmentMedia variant={url && isImageDoc(doc) ? "image" : "icon"}>
          {url && isImageDoc(doc) ? (
            // URL firmada directa: sin object URLs, sin fugas de recursos multimedia.
            <img src={url} alt={doc.label} loading="lazy" />
          ) : urlQuery.isPending ? (
            <span className="text-xs text-muted-foreground">Cargando…</span>
          ) : (
            <ImageIcon aria-hidden="true" />
          )}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{doc.label}</AttachmentTitle>
          <AttachmentDescription>
            {categoryLabel(doc.category)}
            {doc.toothNumber != null ? ` · Pieza ${doc.toothNumber}` : ""}
          </AttachmentDescription>
        </AttachmentContent>
        <AttachmentTrigger aria-label={`Ver ${doc.label}`} onClick={() => onOpen(doc)} />
      </Attachment>
    </li>
  );
}

function DocumentRow({
  doc,
  showEncounter,
  onOpen,
}: {
  doc: PatientDocument;
  showEncounter: boolean;
  onOpen: (doc: PatientDocument) => void;
}) {
  return (
    <Attachment orientation="horizontal" className="w-full">
      <AttachmentMedia variant="icon">
        {isPdfDoc(doc) ? <FileText aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{doc.label}</AttachmentTitle>
        <AttachmentDescription>
          {categoryLabel(doc.category)}
          {doc.toothNumber != null ? ` · Pieza ${doc.toothNumber}` : ""}
          {showEncounter && doc.encounterId ? " · Atención" : ""} ·{" "}
          {(doc.sizeBytes / 1024).toFixed(0)} KB · {timeAgo(doc.createdAt)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <Button size="sm" variant="outline" onClick={() => onOpen(doc)} aria-label={`Ver ${doc.label}`}>
          Ver
        </Button>
      </AttachmentActions>
    </Attachment>
  );
}

function DocumentViewer({ patientId, doc }: { patientId: string; doc: PatientDocument }) {
  const urlQuery = useSignedUrl(patientId, doc.id);
  const url = urlQuery.data?.data.url ?? null;
  const error =
    urlQuery.error instanceof ApiError
      ? (urlQuery.error.shape.message ?? "No se pudo obtener el documento.")
      : urlQuery.error
        ? "No se pudo obtener el documento."
        : null;

  if (urlQuery.isPending) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (error || !url) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">{error ?? "No se pudo obtener el documento."}</p>
        <Button size="sm" variant="outline" onClick={() => void urlQuery.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {isImageDoc(doc) ? (
        <img src={url} alt={doc.label} className="max-h-[70vh] w-full rounded-md object-contain" />
      ) : isPdfDoc(doc) ? (
        <embed src={url} type="application/pdf" className="h-[70vh] w-full rounded-md border" />
      ) : (
        <p className="text-sm text-muted-foreground">
          Vista previa no disponible para este tipo de archivo.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => window.open(url, "_blank", "noopener")}>
          Abrir en pestaña nueva
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = doc.label;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          }}
        >
          Descargar
        </Button>
      </div>
    </div>
  );
}

interface PickedFile {
  file: File;
  previewUrl: string | null;
}

function UploadDrawer({
  patientId,
  encounterId,
  open,
  onOpenChange,
  onSuccess,
  beforeWrite,
  onPendingChange,
  disabled,
}: {
  patientId: string;
  encounterId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [category, setCategory] = useState<string>("radiografia");
  const [label, setLabel] = useState("");
  const [tooth, setTooth] = useState<string>(NO_TOOTH);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ file?: string; label?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fileId = useId();
  const categoryId = useId();
  const labelId = useId();
  const pieceId = useId();

  const discardPicked = () => {
    if (picked?.previewUrl) URL.revokeObjectURL(picked.previewUrl);
    setPicked(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const reset = () => {
    setCategory("radiografia");
    setLabel("");
    setTooth(NO_TOOTH);
    discardPicked();
    setDragging(false);
    setFieldErrors({});
    setServerError(null);
  };

  const acceptFile = (file: File | undefined | null) => {
    if (!file) return;
    if (picked?.previewUrl) URL.revokeObjectURL(picked.previewUrl);
    setPicked({
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    });
    setFieldErrors((prev) => ({ ...prev, file: undefined }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || disabled) return;
    setServerError(null);
    const file = picked?.file ?? null;
    // Solo errores alineados con el esquema del servidor (tipo/tamaño, category/label, pieza FDI).
    const errors: { file?: string; label?: string } = {};
    if (!file || file.size === 0) {
      errors.file = "Adjunta un archivo.";
    } else if (!ACCEPTED_TYPES.includes(file.type)) {
      errors.file = "Solo se admiten JPG, PNG, WebP o PDF.";
    } else if (file.size > MAX_BYTES) {
      errors.file = "El archivo no puede superar 10 MB.";
    }
    const trimmed = label.trim();
    if (!trimmed) {
      errors.label = "La etiqueta es obligatoria.";
    } else if (trimmed.length > 200) {
      errors.label = "La etiqueta debe tener 1–200 caracteres.";
    }
    setFieldErrors(errors);
    if (errors.file || errors.label || !file) return;

    setPending(true);
    onPendingChange?.(true);
    try {
      await beforeWrite?.();
      const form = new FormData();
      form.append("file", file);
      form.append("category", category);
      form.append("label", trimmed);
      if (tooth !== NO_TOOTH) form.append("toothNumber", tooth);
      if (encounterId) form.append("encounterId", encounterId);
      const slug =
        typeof window === "undefined" ? null : orgSlugFromHostname(window.location.hostname);
      const response = await fetch(`${API_URL}/api/patients/${patientId}/documents`, {
        method: "POST",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body: form,
      });
      if (!response.ok) {
        let message = `Error ${response.status}`;
        try {
          const body = (await response.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          // cuerpo no-JSON
        }
        throw new Error(message);
      }
      await onSuccess();
      reset();
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "No se pudo subir el documento.");
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  };

  const pieceItems: Record<string, string> = {
    [NO_TOOTH]: "Sin pieza",
    ...Object.fromEntries(
      [...FDI_ADULT, ...FDI_CHILD].map((n) => [String(n), `Pieza ${n}`] as const),
    ),
  };

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (pending) return;
        reset();
        onOpenChange(false);
      }}
      title="Subir imagen o documento"
      description={`PDF o imagen JPG, PNG o WebP, máx. 10 MB.${encounterId ? " Se vinculará a esta atención." : ""}`}
      onSubmit={(e) => void onSubmit(e)}
      isSubmitting={pending}
      submitDisabled={disabled}
      submitLabel="Subir"
      error={serverError}
    >
      <fieldset disabled={pending || disabled} className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={fileId}>Archivo</FieldLabel>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              acceptFile(event.dataTransfer.files?.[0]);
            }}
            className={`flex flex-col gap-2 rounded-lg border border-dashed p-4 transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
          >
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              name="file"
              aria-label="Archivo"
              accept={ACCEPT_ATTR}
              className="sr-only"
              onChange={(e) => acceptFile(e.currentTarget.files?.[0])}
            />
            {picked ? (
              <Attachment
                state={pending ? "uploading" : serverError ? "error" : "done"}
                orientation="horizontal"
                className="w-full"
              >
                <AttachmentMedia variant={picked.previewUrl ? "image" : "icon"}>
                  {picked.previewUrl ? (
                    <img src={picked.previewUrl} alt={picked.file.name} />
                  ) : (
                    <FileText aria-hidden="true" />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{picked.file.name}</AttachmentTitle>
                  <AttachmentDescription>
                    {picked.file.type || "archivo"} · {(picked.file.size / 1024).toFixed(0)} KB
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label="Descartar archivo"
                    disabled={pending}
                    onClick={discardPicked}
                  >
                    {serverError ? <Trash2 aria-hidden="true" /> : <X aria-hidden="true" />}
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ) : (
              <label
                htmlFor={fileId}
                className="flex cursor-pointer flex-col items-center gap-1 text-center text-sm text-muted-foreground"
              >
                <Upload className="size-5" aria-hidden="true" />
                <span className="font-medium text-foreground">Arrastra un archivo o haz clic para elegirlo</span>
                <span>JPG, PNG, WebP o PDF · máx. 10 MB</span>
              </label>
            )}
            {fieldErrors.file && <FieldError>{fieldErrors.file}</FieldError>}
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor={categoryId}>Categoría</FieldLabel>
          <Select
            items={Object.fromEntries(UPLOAD_CATEGORIES.map((c) => [c, categoryLabel(c)]))}
            value={category}
            onValueChange={(v) => {
              if (v) setCategory(v);
            }}
          >
            <SelectTrigger id={categoryId} aria-label="Categoría">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UPLOAD_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {categoryLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={labelId}>Etiqueta</FieldLabel>
          <Input
            id={labelId}
            name="label"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="p. ej. Panorámica inicial"
            maxLength={200}
          />
          {fieldErrors.label && <FieldError>{fieldErrors.label}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor={pieceId}>Pieza (opcional)</FieldLabel>
          <Select
            items={pieceItems}
            value={tooth}
            onValueChange={(v) => setTooth(v ?? NO_TOOTH)}
          >
            <SelectTrigger id={pieceId} aria-label="Pieza">
              <SelectValue placeholder="Sin pieza" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(pieceItems).map(([value, text]) => (
                <SelectItem key={value} value={value}>
                  {text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </fieldset>
    </FormDrawer>
  );
}
