import { useId, useRef } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui";

export type AllergySeverity = "leve" | "moderada" | "severa";
export type ConditionStatus = "activa" | "resuelta" | "inactiva";

export interface PatientHealthAllergy {
  substance: string;
  reaction?: string;
  severity: AllergySeverity;
}

export interface PatientHealthCondition {
  name: string;
  status?: ConditionStatus;
  startDate?: string;
  notes?: string;
}

export interface PatientHealthMedication {
  name: string;
  dose?: string;
  frequency?: string;
  notes?: string;
}

export interface PatientHealthValues {
  allergies: PatientHealthAllergy[];
  conditions: PatientHealthCondition[];
  medications: PatientHealthMedication[];
}

interface RegistrationHealthStepProps {
  value: PatientHealthValues;
  onChange: (value: PatientHealthValues) => void;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `fila-${keySeq}`;
}

function keysFor(store: string[], count: number): string[] {
  while (store.length < count) store.push(nextKey());
  return store.slice(0, count);
}

const SEVERITY_LABELS: Record<AllergySeverity, string> = {
  leve: "Leve",
  moderada: "Moderada",
  severa: "Severa",
};

const STATUS_LABELS: Record<ConditionStatus, string> = {
  activa: "Activa",
  resuelta: "Resuelta",
  inactiva: "Inactiva",
};

const NO_STATUS = "__sin-estado__";

export function RegistrationHealthStep({ value, onChange }: RegistrationHealthStepProps) {
  const uid = useId();
  const allergyKeys = useRef<string[]>([]);
  const conditionKeys = useRef<string[]>([]);
  const medicationKeys = useRef<string[]>([]);

  const allergyIds = keysFor(allergyKeys.current, value.allergies.length);
  const conditionIds = keysFor(conditionKeys.current, value.conditions.length);
  const medicationIds = keysFor(medicationKeys.current, value.medications.length);

  function updateAllergy(index: number, patch: Partial<PatientHealthAllergy>): void {
    onChange({
      ...value,
      allergies: value.allergies.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  function updateCondition(index: number, patch: Partial<PatientHealthCondition>): void {
    onChange({
      ...value,
      conditions: value.conditions.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  function updateMedication(index: number, patch: Partial<PatientHealthMedication>): void {
    onChange({
      ...value,
      medications: value.medications.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  function addAllergy(): void {
    allergyKeys.current.push(nextKey());
    onChange({ ...value, allergies: [...value.allergies, { substance: "", severity: "leve" }] });
  }

  function removeAllergy(index: number): void {
    allergyKeys.current.splice(index, 1);
    onChange({ ...value, allergies: value.allergies.filter((_, i) => i !== index) });
  }

  function addCondition(): void {
    conditionKeys.current.push(nextKey());
    onChange({ ...value, conditions: [...value.conditions, { name: "" }] });
  }

  function removeCondition(index: number): void {
    conditionKeys.current.splice(index, 1);
    onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== index) });
  }

  function addMedication(): void {
    medicationKeys.current.push(nextKey());
    onChange({ ...value, medications: [...value.medications, { name: "" }] });
  }

  function removeMedication(index: number): void {
    medicationKeys.current.splice(index, 1);
    onChange({ ...value, medications: value.medications.filter((_, i) => i !== index) });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Alergias</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {value.allergies.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin alergias registradas.</p>
          )}
          {value.allergies.map((row, i) => {
            const key = allergyIds[i] ?? `alergia-${i}`;
            const base = `${uid}-alergia-${key}`;
            const removeLabel = `Quitar alergia ${row.substance.trim() === "" ? i + 1 : row.substance.trim()}`;
            return (
              <div key={key} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${base}-sustancia`}>Sustancia</FieldLabel>
                  <Input
                    id={`${base}-sustancia`}
                    value={row.substance}
                    placeholder="Penicilina"
                    onChange={(e) => updateAllergy(i, { substance: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-reaccion`}>Reacción</FieldLabel>
                  <Input
                    id={`${base}-reaccion`}
                    value={row.reaction ?? ""}
                    placeholder="Urticaria"
                    onChange={(e) =>
                      updateAllergy(i, { reaction: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-severidad`}>Severidad</FieldLabel>
                  <Select
                    items={SEVERITY_LABELS}
                    value={row.severity}
                    onValueChange={(v) => { if (v) updateAllergy(i, { severity: v }); }}
                  >
                    <SelectTrigger id={`${base}-severidad`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SEVERITY_LABELS) as AllergySeverity[]).map((s) => (
                        <SelectItem key={s} value={s}>
                          {SEVERITY_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex items-end sm:justify-end">
                  <Button type="button" variant="outline" size="sm" aria-label={removeLabel} onClick={() => removeAllergy(i)}>
                    Quitar
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={addAllergy}>
              Agregar alergia
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Condiciones médicas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {value.conditions.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin condiciones registradas.</p>
          )}
          {value.conditions.map((row, i) => {
            const key = conditionIds[i] ?? `condicion-${i}`;
            const base = `${uid}-condicion-${key}`;
            const removeLabel = `Quitar condición ${row.name.trim() === "" ? i + 1 : row.name.trim()}`;
            return (
              <div key={key} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${base}-nombre`}>Condición</FieldLabel>
                  <Input
                    id={`${base}-nombre`}
                    value={row.name}
                    placeholder="Hipertensión arterial"
                    onChange={(e) => updateCondition(i, { name: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-estado`}>Estado</FieldLabel>
                  <Select
                    items={{ [NO_STATUS]: "Sin indicar", ...STATUS_LABELS }}
                    value={row.status ?? NO_STATUS}
                    onValueChange={(v) =>
                      updateCondition(i, { status: !v || v === NO_STATUS ? undefined : (v as ConditionStatus) })
                    }
                  >
                    <SelectTrigger id={`${base}-estado`}>
                      <SelectValue placeholder="Sin indicar" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_STATUS}>Sin indicar</SelectItem>
                      {(Object.keys(STATUS_LABELS) as ConditionStatus[]).map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-inicio`}>Fecha de inicio</FieldLabel>
                  <Input
                    id={`${base}-inicio`}
                    type="date"
                    value={row.startDate ?? ""}
                    onChange={(e) =>
                      updateCondition(i, { startDate: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-notas`}>Notas</FieldLabel>
                  <Textarea
                    id={`${base}-notas`}
                    rows={2}
                    value={row.notes ?? ""}
                    onChange={(e) =>
                      updateCondition(i, { notes: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                </Field>
                <div className="flex items-end sm:col-span-2 sm:justify-end">
                  <Button type="button" variant="outline" size="sm" aria-label={removeLabel} onClick={() => removeCondition(i)}>
                    Quitar
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={addCondition}>
              Agregar condición
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Medicamentos</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {value.medications.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin medicamentos registrados.</p>
          )}
          {value.medications.map((row, i) => {
            const key = medicationIds[i] ?? `medicamento-${i}`;
            const base = `${uid}-medicamento-${key}`;
            const removeLabel = `Quitar medicamento ${row.name.trim() === "" ? i + 1 : row.name.trim()}`;
            return (
              <div key={key} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${base}-nombre`}>Medicamento</FieldLabel>
                  <Input
                    id={`${base}-nombre`}
                    value={row.name}
                    placeholder="Losartán"
                    onChange={(e) => updateMedication(i, { name: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-dosis`}>Dosis</FieldLabel>
                  <Input
                    id={`${base}-dosis`}
                    value={row.dose ?? ""}
                    placeholder="50 mg"
                    onChange={(e) =>
                      updateMedication(i, { dose: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-frecuencia`}>Frecuencia</FieldLabel>
                  <Input
                    id={`${base}-frecuencia`}
                    value={row.frequency ?? ""}
                    placeholder="Cada 12 horas"
                    onChange={(e) =>
                      updateMedication(i, { frequency: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${base}-notas`}>Notas</FieldLabel>
                  <Textarea
                    id={`${base}-notas`}
                    rows={2}
                    value={row.notes ?? ""}
                    onChange={(e) =>
                      updateMedication(i, { notes: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                </Field>
                <div className="flex items-end sm:col-span-2 sm:justify-end">
                  <Button type="button" variant="outline" size="sm" aria-label={removeLabel} onClick={() => removeMedication(i)}>
                    Quitar
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={addMedication}>
              Agregar medicamento
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
