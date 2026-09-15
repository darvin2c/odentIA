import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldLabel, Textarea } from "@odentia/ui";
import { FormDrawer } from "@odentia/ui-patterns";
import { useId, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import { Cie10Search } from "./cie10-search";

export function QuickNoteDrawer({ patientId, encounterId, onSaved }: { patientId: string; encounterId?: string; onSaved?: () => void }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const save = useMutation({
    mutationFn: () => apiFetch(`/api/patients/${patientId}/notes`, { method: "POST", body: JSON.stringify({ note: note.trim(), ...(code ? { diagnosisCode: code } : {}), ...(encounterId ? { encounterId } : {}) }) }),
    onSuccess: () => {
      setNote(""); setCode(""); setOpen(false);
      for (const key of ["patient-notes", "timeline", "patient-summary", "encounter"]) void queryClient.invalidateQueries({ queryKey: [key, patientId] });
      onSaved?.();
    },
  });
  if (!canWrite) return null;
  return <>
    <Button variant="outline" onClick={() => { save.reset(); setOpen(true); }}>Nota rápida</Button>
    <FormDrawer
      open={open}
      onClose={() => { if (!save.isPending) setOpen(false); }}
      title="Nota rápida"
      description="Las notas clínicas son inmutables. Las correcciones se registran en una nueva nota."
      onSubmit={(event) => { event.preventDefault(); if (note.trim()) save.mutate(); }}
      isSubmitting={save.isPending}
      submitDisabled={!note.trim()}
      submitLabel={save.isPending ? "Guardando…" : "Guardar nota"}
      error={save.isError ? save.error.message : null}
    >
      <div className="flex flex-col gap-4">
        <Field><FieldLabel htmlFor={id}>Nota clínica</FieldLabel><Textarea id={id} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} rows={5} required disabled={save.isPending} /></Field>
        <Cie10Search value={code} onChange={setCode} disabled={save.isPending} />
      </div>
    </FormDrawer>
  </>;
}
