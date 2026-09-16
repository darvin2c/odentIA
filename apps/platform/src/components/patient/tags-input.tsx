import { useId, useRef, useState } from "react";
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTags } from "@odentia/clinical";
import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import { X } from "lucide-react";

export interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  suggestions?: string[];
}

function canonicalTag(raw: string): string | null {
  try {
    return normalizeTags([raw])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Campo de etiquetas compartido: chips removibles, contador 20/40, sugerencias
 * de etiquetas existentes. Los duplicados canónicos no se crean.
 */
export function TagsInput({ value, onChange, disabled = false, suggestions = [] }: TagsInputProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const commit = (raw: string) => {
    if (!raw.trim()) return false;
    try {
      const next = normalizeTags([...value, raw]);
      const duplicate = next.length === value.length;
      onChange(next);
      inputRef.current?.setCustomValidity("");
      setDraft("");
      setHint(duplicate ? "La etiqueta ya estaba agregada; no se ha duplicado." : null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Etiqueta inválida";
      inputRef.current?.setCustomValidity(message);
      setHint(message);
      return false;
    }
  };

  const remove = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
    setHint(null);
  };

  const draftCanon = draft.trim() ? (canonicalTag(draft) ?? draft.trim().toLowerCase()) : null;
  const visibleSuggestions = suggestions
    .map((s) => canonicalTag(s))
    .filter((canon): canon is string => !!canon && !value.includes(canon))
    .filter((canon) => !draftCanon || canon.includes(draftCanon))
    .slice(0, 8);

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>
        Etiquetas{" "}
        <span className="font-normal text-muted-foreground">
          ({value.length}/{MAX_TAGS})
        </span>
      </FieldLabel>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Etiquetas agregadas">
          {value.map((tag) => (
            <li key={tag}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {tag}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-4 w-4 p-0"
                  disabled={disabled}
                  aria-label={`Quitar etiqueta ${tag}`}
                  onClick={() => remove(tag)}
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={inputId}
          ref={inputRef}
          value={draft}
          disabled={disabled || value.length >= MAX_TAGS}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            inputRef.current?.setCustomValidity("");
            setHint(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
              remove(value[value.length - 1]!);
            }
          }}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
          placeholder="Escribe y pulsa Enter"
          maxLength={200}
          aria-describedby={`${inputId}-guia`}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !draft.trim()}
          onClick={() => commit(draft)}
        >
          Agregar
        </Button>
      </div>
      {visibleSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Sugerencias">
          {visibleSuggestions.map((canon) => (
            <Button
              key={canon}
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              title={`Agregar ${canon}`}
              onClick={() => commit(canon)}
            >
              + {canon}
            </Button>
          ))}
        </div>
      )}
      {hint ? (
        <FieldError>{hint}</FieldError>
      ) : (
        <p id={`${inputId}-guia`} className="text-xs text-muted-foreground">
          Máx. {MAX_TAGS} etiquetas de hasta {MAX_TAG_LENGTH} caracteres. Espacios, guiones y
          guiones bajos se unifican (“Tag 1”, “tag-1” y “tag_1” son la misma).
        </p>
      )}
    </Field>
  );
}
