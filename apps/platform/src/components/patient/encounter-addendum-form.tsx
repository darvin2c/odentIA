import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Field, FieldLabel, Textarea } from "@odentia/ui";
import { SubmitButton } from "@odentia/ui-patterns";
import { useId, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";

const MAX_LENGTH = 4000;

/** Corrección inmutable sobre una atención finalizada (POST {text}, máx. 4000). */
export function EncounterAddendumForm({
  patientId,
  encounterId,
  onSaved,
}: {
  patientId: string;
  encounterId: string;
  onSaved?: () => void;
}) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const id = useId();
  const [text, setText] = useState("");
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/encounters/${encounterId}/addenda`, {
        method: "POST",
        body: JSON.stringify({ text: text.trim() }),
      }),
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] });
      void queryClient.invalidateQueries({ queryKey: ["timeline", patientId] });
      onSaved?.();
    },
  });

  if (!canWrite) return null;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && !save.isPending) save.mutate();
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>Agregar corrección (adenda)</FieldLabel>
        <Textarea
          id={id}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={MAX_LENGTH}
          rows={4}
          required
          disabled={save.isPending}
          placeholder="Corrección posterior al cierre…"
        />
        <p className="text-xs text-muted-foreground">
          {text.length}/{MAX_LENGTH} · Las adendas son inmutables: no se pueden editar ni eliminar.
        </p>
      </Field>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
      <div>
        <SubmitButton type="submit" pending={save.isPending} disabled={!text.trim()}>
          Guardar corrección
        </SubmitButton>
      </div>
    </form>
  );
}
