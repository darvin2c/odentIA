import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Field, FieldLabel, Input } from "@odentia/ui";
import { useEffect, useId, useState } from "react";
import { apiFetch } from "../../lib/api";

interface Cie10Result {
  code: string;
  description: string;
}

export function Cie10Search({ value, onChange, label = "Diagnóstico CIE-10", disabled = false }: {
  value: string;
  onChange: (code: string, description: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useQuery({
    queryKey: ["cie10", debounced],
    queryFn: () => apiFetch<{ data: Cie10Result[] }>(`/api/cie10?q=${encodeURIComponent(debounced)}`),
    enabled: !disabled && debounced.length > 0,
    staleTime: 60_000,
  });
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} value={query} disabled={disabled} placeholder="Buscar código o descripción…" onChange={(event) => setQuery(event.target.value)} />
      {value && <div className="flex items-center gap-2"><Badge>{value}</Badge>{!disabled && <Button type="button" size="sm" variant="ghost" onClick={() => { onChange("", ""); setQuery(""); }}>Quitar código</Button>}</div>}
      {!disabled && query.trim() && (
        <div className="max-h-52 overflow-auto rounded-md border p-1">
          {results.isFetching || query.trim() !== debounced ? <p className="p-2 text-sm text-muted-foreground">Buscando…</p> : results.isError ? <p role="alert" className="p-2 text-sm text-destructive">{results.error.message}</p> : (
            <ul aria-label="Diagnósticos disponibles">
              {(results.data?.data ?? []).map((item) => (
                <li key={item.code}>
                  <button type="button" className="flex w-full flex-col rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { onChange(item.code, item.description); setQuery(""); }}>
                    <span className="font-medium">{item.code}</span><span className="text-muted-foreground">{item.description}</span>
                  </button>
                </li>
              ))}
              {results.data?.data.length === 0 && <li className="p-2 text-sm text-muted-foreground">Sin resultados.</li>}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}
