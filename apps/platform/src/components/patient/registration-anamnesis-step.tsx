import { useId } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
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
import type { AnamnesisAnswers } from "../../lib/patients";

interface RegistrationAnamnesisStepProps {
  value: AnamnesisAnswers;
  onChange: (value: AnamnesisAnswers) => void;
  consent: boolean;
  onConsentChange: (value: boolean) => void;
  showConsent?: boolean;
}

type Rec = Record<string, unknown>;

type ExperienciaPrevia = "positiva" | "regular" | "traumatica";
type AnsiedadDental = "ninguna" | "leve" | "moderada" | "alta";
type HigieneOral = "buena" | "regular" | "mala";

const NONE = "__ninguno__";

const EXPERIENCIA_LABELS: Record<ExperienciaPrevia, string> = {
  positiva: "Positiva",
  regular: "Regular",
  traumatica: "Traumática",
};

const ANSIEDAD_LABELS: Record<AnsiedadDental, string> = {
  ninguna: "Ninguna",
  leve: "Leve",
  moderada: "Moderada",
  alta: "Alta",
};

const HIGIENE_LABELS: Record<HigieneOral, string> = {
  buena: "Buena",
  regular: "Regular",
  mala: "Mala",
};

function strOf(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function groupOf(value: AnamnesisAnswers, group: string): Rec {
  const g = (value as Rec)[group];
  return typeof g === "object" && g !== null ? { ...(g as Rec) } : {};
}

function subOf(group: Rec, sub: string): Rec {
  const s = group[sub];
  return typeof s === "object" && s !== null ? { ...(s as Rec) } : {};
}

/** Texto tal cual se escribe; vacío se guarda como ausente. */
function optStr(raw: string): string | undefined {
  return raw === "" ? undefined : raw;
}

/**
 * Recorta recursivamente strings y elimina vacíos antes de persistir: el
 * trim no debe correr en cada tecla (impide escribir espacios) sino al guardar.
 */
export function sanitizeAnswers(value: AnamnesisAnswers): AnamnesisAnswers {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const t = node.trim();
      return t === "" ? undefined : t;
    }
    if (Array.isArray(node)) {
      const items = node.map(walk).filter((x) => x !== undefined);
      return items.length > 0 ? items : undefined;
    }
    if (node !== null && typeof node === "object") {
      const out: Rec = {};
      for (const [key, child] of Object.entries(node as Rec)) {
        const cleaned = walk(child);
        if (cleaned !== undefined) out[key] = cleaned;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    return node;
  };
  return (walk(value) ?? {}) as AnamnesisAnswers;
}

function parseIntOrUndefined(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) ? n : undefined;
}

function parseList(raw: string, upper: boolean): string[] | undefined {
  const items = raw
    .split(",")
    .map((x) => (upper ? x.trim().toUpperCase() : x.trim()))
    .filter((x) => x !== "")
    .slice(0, 10);
  return items.length > 0 ? items : undefined;
}

export function RegistrationAnamnesisStep({
  value,
  onChange,
  consent,
  onConsentChange,
  showConsent = true,
}: RegistrationAnamnesisStepProps) {
  const uid = useId();
  const rec = value as Rec;

  function setTop(key: string, next: unknown): void {
    const out: Rec = { ...(value as Rec) };
    if (next === undefined) delete out[key];
    else out[key] = next;
    onChange(out as AnamnesisAnswers);
  }

  function setNested(group: string, key: string, next: unknown): void {
    const g = groupOf(value, group);
    if (next === undefined) delete g[key];
    else g[key] = next;
    setTop(group, Object.keys(g).length > 0 ? g : undefined);
  }

  function setDeep(group: string, sub: string, key: string, next: unknown): void {
    const g = groupOf(value, group);
    const s = subOf(g, sub);
    if (next === undefined) delete s[key];
    else s[key] = next;
    if (Object.keys(s).length > 0) g[sub] = s;
    else delete g[sub];
    setTop(group, Object.keys(g).length > 0 ? g : undefined);
  }

  const personales = groupOf(value, "antecedentesPersonales");
  const odontologicos = groupOf(value, "antecedentesOdontologicos");
  const examen = groupOf(value, "examenClinico");
  const extraoral = subOf(examen, "extraoral");
  const intraoral = subOf(examen, "intraoral");

  const id = (name: string): string => `${uid}-${name}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Motivo de consulta</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={id("motivo")}>Motivo de consulta</FieldLabel>
            <Textarea
              id={id("motivo")}
              rows={2}
              value={strOf(rec["motivoConsulta"])}
              onChange={(e) => setTop("motivoConsulta", optStr(e.target.value))}
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={id("tiempo")}>Tiempo de enfermedad</FieldLabel>
            <Input
              id={id("tiempo")}
              value={strOf(rec["tiempoEnfermedad"])}
              onChange={(e) => setTop("tiempoEnfermedad", optStr(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Antecedentes personales</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={id("ap-enfermedades")}>Enfermedades</FieldLabel>
            <Textarea
              id={id("ap-enfermedades")}
              rows={2}
              value={strOf(personales["enfermedades"])}
              onChange={(e) => setNested("antecedentesPersonales", "enfermedades", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ap-hospitalizaciones")}>Hospitalizaciones</FieldLabel>
            <Input
              id={id("ap-hospitalizaciones")}
              value={strOf(personales["hospitalizaciones"])}
              onChange={(e) => setNested("antecedentesPersonales", "hospitalizaciones", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ap-cirugias")}>Cirugías</FieldLabel>
            <Input
              id={id("ap-cirugias")}
              value={strOf(personales["cirugias"])}
              onChange={(e) => setNested("antecedentesPersonales", "cirugias", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ap-transfusiones")}>Transfusiones</FieldLabel>
            <Input
              id={id("ap-transfusiones")}
              value={strOf(personales["transfusiones"])}
              onChange={(e) => setNested("antecedentesPersonales", "transfusiones", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ap-medicacion")}>Medicación habitual</FieldLabel>
            <Input
              id={id("ap-medicacion")}
              value={strOf(personales["medicacionHabitual"])}
              onChange={(e) => setNested("antecedentesPersonales", "medicacionHabitual", optStr(e.target.value))}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox
              id={id("ap-embarazo")}
              checked={personales["embarazo"] === true}
              onCheckedChange={(c: boolean) =>
                setNested("antecedentesPersonales", "embarazo", c === true ? true : undefined)
              }
            />
            <label htmlFor={id("ap-embarazo")} className="text-sm">
              Embarazo
            </label>
          </div>
          <Field>
            <FieldLabel htmlFor={id("ap-semanas")}>Semanas de embarazo (0–42)</FieldLabel>
            <Input
              id={id("ap-semanas")}
              type="number"
              min={0}
              max={42}
              value={strOf(personales["semanasEmbarazo"])}
              onChange={(e) => setNested("antecedentesPersonales", "semanasEmbarazo", parseIntOrUndefined(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Antecedentes familiares</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field>
            <FieldLabel htmlFor={id("familiares")}>Antecedentes familiares</FieldLabel>
            <Textarea
              id={id("familiares")}
              rows={2}
              value={strOf(rec["antecedentesFamiliares"])}
              onChange={(e) => setTop("antecedentesFamiliares", optStr(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Antecedentes odontológicos</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={id("od-ultima")}>Última visita</FieldLabel>
            <Input
              id={id("od-ultima")}
              value={strOf(odontologicos["ultimaVisita"])}
              onChange={(e) => setNested("antecedentesOdontologicos", "ultimaVisita", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("od-cepillados")}>Cepillados al día (0–10)</FieldLabel>
            <Input
              id={id("od-cepillados")}
              type="number"
              min={0}
              max={10}
              value={strOf(odontologicos["cepilladosAlDia"])}
              onChange={(e) => setNested("antecedentesOdontologicos", "cepilladosAlDia", parseIntOrUndefined(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("od-experiencia")}>Experiencia previa</FieldLabel>
            <Select
              items={{ [NONE]: "Sin indicar", ...EXPERIENCIA_LABELS }}
              value={strOf(odontologicos["experienciaPrevia"]) === "" ? NONE : strOf(odontologicos["experienciaPrevia"])}
              onValueChange={(v) =>
                setNested(
                  "antecedentesOdontologicos",
                  "experienciaPrevia",
                  !v || v === NONE ? undefined : (v as ExperienciaPrevia),
                )
              }
            >
              <SelectTrigger id={id("od-experiencia")}>
                <SelectValue placeholder="Sin indicar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin indicar</SelectItem>
                {(Object.keys(EXPERIENCIA_LABELS) as ExperienciaPrevia[]).map((o) => (
                  <SelectItem key={o} value={o}>
                    {EXPERIENCIA_LABELS[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={id("od-ansiedad")}>Ansiedad dental</FieldLabel>
            <Select
              items={{ [NONE]: "Sin indicar", ...ANSIEDAD_LABELS }}
              value={strOf(odontologicos["ansiedadDental"]) === "" ? NONE : strOf(odontologicos["ansiedadDental"])}
              onValueChange={(v) =>
                setNested(
                  "antecedentesOdontologicos",
                  "ansiedadDental",
                  !v || v === NONE ? undefined : (v as AnsiedadDental),
                )
              }
            >
              <SelectTrigger id={id("od-ansiedad")}>
                <SelectValue placeholder="Sin indicar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin indicar</SelectItem>
                {(Object.keys(ANSIEDAD_LABELS) as AnsiedadDental[]).map((o) => (
                  <SelectItem key={o} value={o}>
                    {ANSIEDAD_LABELS[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id={id("od-hilo")}
                checked={odontologicos["hiloDental"] === true}
                onCheckedChange={(c: boolean) =>
                  setNested("antecedentesOdontologicos", "hiloDental", c === true ? true : undefined)
                }
              />
              <label htmlFor={id("od-hilo")} className="text-sm">
                Hilo dental
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={id("od-bruxismo")}
                checked={odontologicos["bruxismo"] === true}
                onCheckedChange={(c: boolean) =>
                  setNested("antecedentesOdontologicos", "bruxismo", c === true ? true : undefined)
                }
              />
              <label htmlFor={id("od-bruxismo")} className="text-sm">
                Bruxismo
              </label>
            </div>
          </div>
          <Field>
            <FieldLabel htmlFor={id("od-habitos")}>Hábitos (separados por coma, máx. 10)</FieldLabel>
            <Input
              id={id("od-habitos")}
              placeholder="tabaquismo, onicofagia"
              value={Array.isArray(odontologicos["habitos"]) ? (odontologicos["habitos"] as string[]).join(", ") : ""}
              onChange={(e) => setNested("antecedentesOdontologicos", "habitos", parseList(e.target.value, false))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Examen clínico</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={id("ex-atm")}>ATM</FieldLabel>
            <Input
              id={id("ex-atm")}
              value={strOf(extraoral["atm"])}
              onChange={(e) => setDeep("examenClinico", "extraoral", "atm", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-ganglios")}>Ganglios</FieldLabel>
            <Input
              id={id("ex-ganglios")}
              value={strOf(extraoral["ganglios"])}
              onChange={(e) => setDeep("examenClinico", "extraoral", "ganglios", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-labios")}>Labios</FieldLabel>
            <Input
              id={id("ex-labios")}
              value={strOf(extraoral["labios"])}
              onChange={(e) => setDeep("examenClinico", "extraoral", "labios", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-higiene")}>Higiene oral</FieldLabel>
            <Select
              items={{ [NONE]: "Sin indicar", ...HIGIENE_LABELS }}
              value={strOf(examen["higieneOral"]) === "" ? NONE : strOf(examen["higieneOral"])}
              onValueChange={(v) =>
                setNested("examenClinico", "higieneOral", !v || v === NONE ? undefined : (v as HigieneOral))
              }
            >
              <SelectTrigger id={id("ex-higiene")}>
                <SelectValue placeholder="Sin indicar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin indicar</SelectItem>
                {(Object.keys(HIGIENE_LABELS) as HigieneOral[]).map((o) => (
                  <SelectItem key={o} value={o}>
                    {HIGIENE_LABELS[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-encias")}>Encías</FieldLabel>
            <Input
              id={id("ex-encias")}
              value={strOf(intraoral["encias"])}
              onChange={(e) => setDeep("examenClinico", "intraoral", "encias", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-lengua")}>Lengua</FieldLabel>
            <Input
              id={id("ex-lengua")}
              value={strOf(intraoral["lengua"])}
              onChange={(e) => setDeep("examenClinico", "intraoral", "lengua", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-paladar")}>Paladar</FieldLabel>
            <Input
              id={id("ex-paladar")}
              value={strOf(intraoral["paladar"])}
              onChange={(e) => setDeep("examenClinico", "intraoral", "paladar", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-piso")}>Piso de boca</FieldLabel>
            <Input
              id={id("ex-piso")}
              value={strOf(intraoral["pisoBoca"])}
              onChange={(e) => setDeep("examenClinico", "intraoral", "pisoBoca", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-carrillos")}>Carrillos</FieldLabel>
            <Input
              id={id("ex-carrillos")}
              value={strOf(intraoral["carrillos"])}
              onChange={(e) => setDeep("examenClinico", "intraoral", "carrillos", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("ex-orofaringe")}>Orofaringe</FieldLabel>
            <Input
              id={id("ex-orofaringe")}
              value={strOf(intraoral["orofaringe"])}
              onChange={(e) => setDeep("examenClinico", "intraoral", "orofaringe", optStr(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Diagnóstico y observaciones</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field>
            <FieldLabel htmlFor={id("diagnostico")}>Diagnóstico presuntivo</FieldLabel>
            <Textarea
              id={id("diagnostico")}
              rows={2}
              value={strOf(rec["diagnosticoPresuntivo"])}
              onChange={(e) => setTop("diagnosticoPresuntivo", optStr(e.target.value))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("cie10")}>Códigos CIE-10 (separados por coma, máx. 10)</FieldLabel>
            <Input
              id={id("cie10")}
              placeholder="K02.1, K04.0"
              value={Array.isArray(rec["diagnosticoCie10"]) ? (rec["diagnosticoCie10"] as string[]).join(", ") : ""}
              onChange={(e) => setTop("diagnosticoCie10", parseList(e.target.value, true))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("observaciones")}>Observaciones</FieldLabel>
            <Textarea
              id={id("observaciones")}
              rows={2}
              value={strOf(rec["observaciones"])}
              onChange={(e) => setTop("observaciones", optStr(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      {showConsent && (
        <Card>
          <CardContent className="flex items-start gap-2 pt-6">
            <Checkbox
              id={id("consentimiento")}
              checked={consent}
              onCheckedChange={(c: boolean) => onConsentChange(c === true)}
            />
            <label htmlFor={id("consentimiento")} className="text-sm">
              Consentimiento para el tratamiento de datos de salud
            </label>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
