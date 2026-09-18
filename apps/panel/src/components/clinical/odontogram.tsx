import { useState } from "react"
import { ToothSVG } from "../../../../platform/src/components/tooth-svg"
import type { OdontogramState } from "../../../../platform/src/lib/patients"
import { ActionForm, Field, QueryState, Section, text, useClinical, useClinicalMutation } from "./shared"
import { IndicationForm } from "./indications"

const rows = [[18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28],[48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38],[55,54,53,52,51,61,62,63,64,65],[85,84,83,82,81,71,72,73,74,75]]
export function OdontogramPanel({patientId}:{patientId:string}) {
  const query=useClinical<OdontogramState>(`/patients/${patientId}/odontogram`); const mutation=useClinicalMutation(); const [tooth,setTooth]=useState(36)
  if(!query.data) return <QueryState query={query} />
  const chart=query.data.data
  return <Section title="Odontograma"><p className="text-sm text-muted-foreground">Selecciona una pieza para registrar un hallazgo o indicar un tratamiento. Notación FDI y representación clínica existente.</p><div className="overflow-x-auto space-y-3">{rows.map(row=><div key={row[0]} className="flex min-w-max justify-center gap-1">{row.map(number=><ToothSVG key={number} toothNumber={number} entries={chart.history.filter(e=>e.toothNumber===number&&!e.voidedAt)} selected={tooth===number} onSelect={()=>setTooth(number)} />)}</div>)}</div><h3 className="font-medium">Pieza {tooth}</h3><ActionForm title="Registrar hallazgo" onSubmit={f=>mutation.mutateAsync({path:`/patients/${patientId}/odontogram`,body:{toothNumber:tooth,condition:text(f,"condition"),surfaces:[text(f,"surface")],details:{variant:"dentin"},note:text(f,"note")||undefined}})}><Field label="Hallazgo" name="condition"><option value="caries">Caries</option></Field><Field label="Superficie" name="surface"><option value="occlusal">Oclusal</option><option value="mesial">Mesial</option><option value="distal">Distal</option><option value="buccal">Vestibular</option><option value="lingual">Lingual</option><option value="incisal">Incisal</option></Field><Field label="Observación" name="note" required={false} /></ActionForm><IndicationForm patientId={patientId} toothNumber={tooth} /></Section>
}
