import { activeFindingsAsOf, ODONTOGRAM_STANDARD } from "@odentia/clinical";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Checkbox, Field, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@odentia/ui";
import { FormDrawer } from "@odentia/ui-patterns";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../lib/api";
import type { OdontogramAssessment, OdontogramEntry, PatientFull } from "../lib/patients";
import { OdontogramDocument } from "./odontogram-document";

const PURPOSES: Record<OdontogramAssessment["purpose"], string> = {
  initial: "Inicio del plan de tratamiento",
  new_findings: "Nuevos hallazgos clínicos",
  completion: "Culminación del plan de tratamiento",
  reentry: "Reingreso del paciente",
  legal: "Solicitud judicial",
  personal: "Solicitud personal",
};

export function OdontogramAssessments({ patientId, history, readOnly, disabled, beforeWrite, onPendingChange }: {
  patientId: string;
  history: OdontogramEntry[];
  readOnly: boolean;
  disabled: boolean;
  beforeWrite?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("current");
  const [purpose, setPurpose] = useState<OdontogramAssessment["purpose"]>("initial");
  const [specifications, setSpecifications] = useState("");
  const [observations, setObservations] = useState("");
  const [examinerName, setExaminerName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [signature, setSignature] = useState<number[][][]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printDocument, setPrintDocument] = useState<OdontogramAssessment | null>(null);
  const query = useQuery({
    queryKey: ["odontogram-assessments", patientId],
    queryFn: () => apiFetch<{ data: OdontogramAssessment[] }>(`/api/patients/${patientId}/odontogram/assessments`),
  });
  const assessments = query.data?.data ?? [];
  const assessment = assessments.find((item) => item.id === selected);
  const reviewCount = history.filter((entry) => entry.needsReview && entry.status !== "voided").length;
  const dirty = !!(specifications || observations || examinerName || registrationNumber || signature.length || confirmed);
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  });
  const documentEntries = assessment?.entries ?? activeFindingsAsOf(history);

  useEffect(() => {
    if (!printDocument) return;
    const finish = () => {
      document.body.classList.remove("odontogram-printing");
      setPrintDocument(null);
    };
    document.body.classList.add("odontogram-printing");
    window.addEventListener("afterprint", finish, { once: true });
    const frame = window.requestAnimationFrame(() => window.print());
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("odontogram-printing");
    };
  }, [printDocument]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || disabled || readOnly) return;
    if (!examinerName.trim() || !registrationNumber.trim() || !signature.some((stroke) => stroke.length >= 2) || !confirmed) {
      setError("Completa la identificación profesional, firma y confirmación de la evaluación.");
      return;
    }
    setPending(true);
    onPendingChange?.(true);
    setError(null);
    try {
      await beforeWrite?.();
      const result = await apiFetch<{ data: OdontogramAssessment }>(`/api/patients/${patientId}/odontogram/assessments`, {
        method: "POST",
        body: JSON.stringify({ purpose, specifications: specifications.trim(), observations: observations.trim(), examinerName: examinerName.trim(), registrationNumber: registrationNumber.trim(), signature }),
      });
      await queryClient.invalidateQueries({ queryKey: ["odontogram-assessments", patientId] });
      setSelected(result.data.id);
      setOpen(false);
      setSpecifications("");
      setObservations("");
      setSignature([]);
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo registrar la evaluación.");
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }

  return <section className="min-w-0 rounded-lg border p-4 sm:p-6" aria-label="Documento normativo del odontograma">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h3 className="text-lg font-semibold">Evaluaciones del odontograma</h3><p className="text-sm text-muted-foreground">{ODONTOGRAM_STANDARD} · nomenclatura FDI. Cada evaluación firmada conserva una copia inalterable de sus hallazgos.</p></div>
      {!readOnly && <Button disabled={disabled || pending || query.isPending} onClick={() => { setError(null); setOpen(true); }}>Registrar evaluación</Button>}
    </div>
    {query.isError && <p role="alert" className="mt-3 text-sm text-destructive">{query.error.message} <Button variant="link" onClick={() => query.refetch()}>Reintentar</Button></p>}
    <div className="my-4 flex flex-wrap items-end gap-3">
      <Field className="w-full sm:max-w-sm"><FieldLabel htmlFor={`${id}-assessment`}>Documento</FieldLabel><Select value={selected} onValueChange={(value) => setSelected(value ?? "current")} items={{ current: "Estado actual · no firmado", ...Object.fromEntries(assessments.map((item) => [item.id, `${new Date(item.createdAt).toLocaleString("es-PE")} · ${PURPOSES[item.purpose]}`])) }}><SelectTrigger id={`${id}-assessment`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="current">Estado actual · no firmado</SelectItem>{assessments.map((item) => <SelectItem key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString("es-PE")} · {PURPOSES[item.purpose]}</SelectItem>)}</SelectContent></Select></Field>
      {assessment ? <><Badge variant="outline">Evaluación firmada · solo lectura</Badge><Button variant="outline" onClick={() => setPrintDocument(assessment)}>Imprimir evaluación</Button></> : <Badge variant="outline">Vista de trabajo · no es evaluación firmada</Badge>}
    </div>
    <details>
      <summary className="cursor-pointer text-sm font-medium">Ver gráfico normativo completo</summary>
      <div className="mt-4 min-w-0 rounded-lg bg-white p-3 text-black">
        <OdontogramDocument entries={documentEntries} date={assessment?.createdAt} specifications={assessment?.specifications} observations={assessment?.observations} examinerName={assessment?.examinerName} registrationNumber={assessment?.registrationNumber} signature={assessment?.signature} patientName={assessment ? `${assessment.patientName} · HC-${String(assessment.patientNumber).padStart(6, "0")}` : patientQuery.data?.data.displayName} />
      </div>
    </details>
    <FormDrawer open={open} onClose={() => setOpen(false)} title="Registrar evaluación del odontograma" description="Confirma la evaluación clínica completa. Se conservarán los hallazgos observados actuales, la fecha y tu firma; las correcciones posteriores no alterarán este documento." onSubmit={save} isDirty={dirty} isSubmitting={pending} error={error} submitLabel="Firmar y conservar evaluación" submitDisabled={disabled || readOnly || reviewCount > 0 || !confirmed} className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]">
      <div className="flex flex-col gap-4">
        {reviewCount > 0 && <p role="alert" className="rounded-lg border p-3 text-sm">Revisa los {reviewCount} registros anteriores antes de firmar. Registra el hallazgo completo y corrige el registro previo con motivo; no se pueden asumir sus datos faltantes.</p>}
        <Field><FieldLabel htmlFor={`${id}-purpose`}>Momento de evaluación</FieldLabel><Select value={purpose} items={PURPOSES} onValueChange={(value) => { if (value && value in PURPOSES) setPurpose(value as OdontogramAssessment["purpose"]); }} disabled={pending}><SelectTrigger id={`${id}-purpose`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(PURPOSES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
        <Field><FieldLabel htmlFor={`${id}-specifications`}>Especificaciones</FieldLabel><Textarea id={`${id}-specifications`} value={specifications} onChange={(event) => setSpecifications(event.target.value)} maxLength={4000} disabled={pending} placeholder="Detalles adicionales de los hallazgos y clasificaciones utilizadas." /></Field>
        <Field><FieldLabel htmlFor={`${id}-observations`}>Observaciones</FieldLabel><Textarea id={`${id}-observations`} value={observations} onChange={(event) => setObservations(event.target.value)} maxLength={4000} disabled={pending} placeholder="Hallazgos no contemplados en la nomenclatura." /></Field>
        <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor={`${id}-examiner`}>Cirujano dentista</FieldLabel><Input id={`${id}-examiner`} value={examinerName} onChange={(event) => setExaminerName(event.target.value)} maxLength={200} required disabled={pending} /></Field><Field><FieldLabel htmlFor={`${id}-registration`}>Número de colegiatura (COP)</FieldLabel><Input id={`${id}-registration`} value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} maxLength={40} required disabled={pending} /></Field></div>
        <SignatureInput value={signature} onChange={setSignature} disabled={pending} />
        <p className="text-xs text-muted-foreground">Firma manuscrita capturada y vinculada al usuario autenticado. No equivale a una firma digital certificada. La evaluación y la identidad profesional declarada son responsabilidad del cirujano dentista.</p>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} disabled={pending} />Confirmo que he evaluado al paciente y que estos son los hallazgos clínicos observados, no procedimientos propuestos.</label>
      </div>
    </FormDrawer>
    {printDocument && typeof document !== "undefined" && createPortal(<div className="odontogram-print-target"><style>{`@media screen {.odontogram-print-target{display:none}} @media print {body.odontogram-printing > :not(.odontogram-print-target){display:none!important} .odontogram-print-target{display:block!important;color:black;background:white}}`}</style><OdontogramDocument entries={printDocument.entries} date={printDocument.createdAt} specifications={printDocument.specifications} observations={printDocument.observations} examinerName={printDocument.examinerName} registrationNumber={printDocument.registrationNumber} signature={printDocument.signature} patientName={`${printDocument.patientName} · HC-${String(printDocument.patientNumber).padStart(6, "0")}`} /></div>, document.body)}
  </section>;
}

function SignatureInput({ value, onChange, disabled }: { value: number[][][]; onChange: (strokes: number[][][]) => void; disabled: boolean }) {
  const current = useRef<number[][] | null>(null);
  function point(event: PointerEvent<SVGSVGElement>): number[] {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)), Math.max(0, Math.min(100, (event.clientY - bounds.top) / bounds.height * 100))];
  }
  return <Field><FieldLabel>Firma manuscrita</FieldLabel><svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-36 w-full touch-none rounded-lg border bg-white" role="img" aria-label="Área para dibujar la firma manuscrita" onPointerDown={(event) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    current.current = [point(event)];
  }} onPointerMove={(event) => {
    if (!current.current || disabled) return;
    if (current.current.length >= 500) return;
    current.current.push(point(event));
    const draft = event.currentTarget.querySelector("[data-signature-draft]");
    draft?.setAttribute("points", current.current.map((p) => p.join(",")).join(" "));
  }} onPointerUp={(event) => {
    const stroke = current.current;
    current.current = null;
    event.currentTarget.querySelector("[data-signature-draft]")?.setAttribute("points", "");
    if (stroke && stroke.length >= 2 && value.length < 50) onChange([...value, stroke]);
  }} onPointerCancel={(event) => {
    current.current = null;
    event.currentTarget.querySelector("[data-signature-draft]")?.setAttribute("points", "");
  }}>{value.map((stroke, index) => <polyline key={index} points={stroke.map((p) => p.join(",")).join(" ")} fill="none" stroke="black" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}<polyline data-signature-draft="" fill="none" stroke="black" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg><Button type="button" variant="outline" size="sm" disabled={disabled || value.length === 0} onClick={() => onChange([])}>Borrar firma</Button></Field>;
}
