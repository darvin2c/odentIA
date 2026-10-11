import { Button, Field, FieldLabel, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Spinner } from "@odentia/ui"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Search, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useDemoRead, useDemoRequest, type DemoSettings } from "./brand-loading-demo.js"
import { DataTable } from "./data-table.js"
import { DEMO_PATIENTS, type DemoPatient } from "./story-fixtures.js"
import { SubmitButton } from "./form/submit-button.js"

export function FieldsScene({ settings, dark }: { settings: DemoSettings; dark: boolean }) {
  const search = useDemoRead(settings)
  const dependent = useDemoRead(settings)
  const [text, setText] = useState("")
  const [result, setResult] = useState<{ query: string; rows: DemoPatient[] } | null>(null)
  const [selected, setSelected] = useState<DemoPatient | null>(null)
  const [options, setOptions] = useState<{ id: string; label: string }[]>([])
  const [option, setOption] = useState("")
  function lookup(value: string) {
    setText(value)
    const query = value.trim()
    if (!query) { search.cancel(); setResult(null); return }
    search.run(() => setResult({ query, rows: DEMO_PATIENTS.filter(row => row.name.toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es"))) }), "No se recibieron las sugerencias de demostración. El texto se conserva.", { debounce: 300 })
  }
  function loadOptions(person: DemoPatient) {
    setOptions([])
    setOption("")
    dependent.run(() => setOptions([{ id: `${person.id}-recepcion`, label: `Seguimiento de ${person.name} · recepción` }, { id: `${person.id}-clinico`, label: `Seguimiento de ${person.name} · profesional` }]), "No se pudieron cargar las opciones de esta persona. No se ofrecen opciones de la selección anterior.")
  }
  const current = !search.busy && !search.error && result?.query === text.trim() ? result : null
  return <section className="loading-flow-card" aria-labelledby="remote-fields-title">
    <div className="loading-flow-card-heading"><div><h2 id="remote-fields-title">02 · Búsqueda y campos dependientes</h2><p>El input sigue editable. Una nueva búsqueda reemplaza a la anterior; nunca se elige una sugerencia obsoleta.</p></div></div>
    <Field><FieldLabel htmlFor="remote-person-search">Buscar persona para vincular (demo)</FieldLabel><InputGroup><InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon><InputGroupInput id="remote-person-search" type="search" value={text} onChange={event => lookup(event.target.value)} placeholder="Escribe Ana o Luis…" aria-busy={search.phase === "loading"} aria-describedby="remote-search-status" /><InputGroupAddon align="inline-end">{search.phase === "loading" && <span className="loading-flow-brand-color"><Spinner aria-hidden="true" style={{ width: 22, height: 22 }} /></span>}{text && <InputGroupButton aria-label="Limpiar búsqueda de sugerencias" onClick={() => lookup("")}><X aria-hidden="true" /></InputGroupButton>}</InputGroupAddon></InputGroup></Field>
    <p id="remote-search-status" className="loading-flow-status" role="status">{search.phase === "debounce" ? "Esperando a que termines de escribir…" : search.phase === "loading" ? `Buscando «${text.trim()}»…` : current ? `${current.rows.length} coincidencias para «${current.query}».` : "Escribe un nombre para consultar sugerencias."}</p>
    {search.error && <div className="loading-flow-error" role="alert">{search.error}<Button variant="link" onClick={() => lookup(text)}>Reintentar búsqueda</Button></div>}
    {current && <ul className="loading-flow-suggestions" aria-label="Sugerencias de personas">{current.rows.map(person => <li key={person.id}><Button variant="outline" aria-pressed={selected?.id === person.id} onClick={() => { setSelected(person); loadOptions(person) }}>{person.name}</Button></li>)}</ul>}
    {current?.rows.length === 0 && <p className="loading-flow-demo-note">Sin coincidencias. Prueba otro nombre; no es un error de conexión.</p>}
    <div className="loading-flow-dependent">
      <p className="loading-flow-current-view">Selección confirmada: {selected?.name ?? "ninguna"}.</p>
      <Field><FieldLabel htmlFor="dependent-demo-select">Opciones de la persona seleccionada</FieldLabel><Select value={option} items={options.map(item => ({ value: item.id, label: item.label }))} onValueChange={value => setOption(value ?? "")} disabled={!selected || dependent.busy || !!dependent.error}><SelectTrigger id="dependent-demo-select" className="w-full min-w-0" aria-busy={dependent.busy}><SelectValue placeholder={dependent.busy ? "Cargando opciones…" : selected ? "Selecciona un seguimiento" : "Primero selecciona una persona"} />{dependent.busy && <span className="loading-flow-brand-color"><Spinner aria-hidden="true" style={{ width: 22, height: 22 }} /></span>}</SelectTrigger><SelectContent className={dark ? "dark" : undefined}>{options.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></Field>
      <p role="status" className="loading-flow-status">{dependent.busy ? `Consultando opciones para ${selected?.name}…` : option ? "Opción elegida en esta demo." : selected && !dependent.error ? `Opciones disponibles para ${selected.name}.` : ""}</p>
      {dependent.error && selected && <div role="alert" className="loading-flow-error">{dependent.error}<Button variant="link" onClick={() => loadOptions(selected)}>Reintentar opciones</Button></div>}
      {selected && <Button variant="ghost" onClick={() => { dependent.cancel(); setSelected(null); setOptions([]); setOption("") }}>Quitar selección</Button>}
    </div>
  </section>
}

const MORE_COLUMNS: ColumnDef<DemoPatient>[] = [
  { accessorKey: "name", header: "Persona", meta: { view: { role: "title" } } },
  { accessorKey: "patientNumber", header: "Historia", meta: { view: { primary: true } } },
]
const IMAGE_LIGHT = new URL("../../../assets/brand/isotipo-light.svg", import.meta.url).href
const IMAGE_DARK = new URL("../../../assets/brand/isotipo-dark.svg", import.meta.url).href

export function MoreAndPreviewScene({ settings, dark }: { settings: DemoSettings; dark: boolean }) {
  const more = useDemoRequest(settings)
  const image = useDemoRead(settings)
  const [visible, setVisible] = useState(2)
  const [imageVersion, setImageVersion] = useState(0)
  const imageAvailable = imageVersion > 0
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const visibleRows = useMemo(() => DEMO_PATIENTS.slice(0, visible), [visible])
  const table = useReactTable({ data: visibleRows, columns: MORE_COLUMNS, getCoreRowModel: getCoreRowModel() })
  function preview() {
    setImageError(false)
    image.run(() => { setImageVersion(version => version + 1); setImageLoaded(false) }, "No se obtuvo la vista previa de demostración. El resto de la pantalla sigue disponible.")
  }
  return <section className="loading-flow-card" aria-labelledby="more-preview-title">
    <div className="loading-flow-card-heading"><div><h2 id="more-preview-title">03 · Cargar más y vista previa</h2><p>La carga incremental no reemplaza lo que ya leíste. Una imagen tiene su propia espera, no bloquea la pantalla completa.</p></div></div>
    <div data-testid="incremental-list"><DataTable table={table} /></div>
    <div className="loading-flow-actions"><SubmitButton variant="outline" pending={more.busy} disabled={visible >= DEMO_PATIENTS.length} onClick={() => more.run(() => setVisible(count => Math.min(count + 2, DEMO_PATIENTS.length)), "No se recibieron los siguientes registros. La lista actual permanece visible.")}>Cargar más</SubmitButton><span role="status" className="loading-flow-current-view">{more.busy ? "Añadiendo resultados…" : `Mostrando ${visible} de ${DEMO_PATIENTS.length}.`}</span></div>
    {more.error && <p role="alert" className="loading-flow-error">{more.error} Puedes volver a pulsar «Cargar más».</p>}
    <div className="loading-flow-dependent">
      <SubmitButton variant="outline" pending={image.busy} onClick={preview}>Consultar vista previa</SubmitButton>
      <div className="loading-flow-file-preview" aria-busy={image.busy || (imageAvailable && !imageLoaded && !imageError)}>
        {imageAvailable && <img key={imageVersion} src={dark ? IMAGE_DARK : IMAGE_LIGHT} alt="Isotipo de demostración, no imagen clínica" onLoad={() => setImageLoaded(true)} onError={() => setImageError(true)} />}
        {!imageAvailable && image.busy && <Skeleton className="h-24 w-32" />}
        {!imageAvailable && !image.busy && <p>Vista previa local de un recurso de marca.</p>}
      </div>
      <p role="status" className="loading-flow-status">{image.busy ? imageLoaded ? "Actualizando referencia; la imagen anterior sigue visible…" : "Preparando vista previa…" : image.error || imageError ? "No se confirmó una vista previa nueva." : imageLoaded ? "Vista previa disponible." : imageAvailable ? "Cargando la imagen…" : ""}</p>
      {(image.error || imageError) && <p role="alert" className="loading-flow-error">{image.error ?? "No se pudo cargar el recurso de imagen."}</p>}
      <p className="loading-flow-demo-note">Para subidas o descargas con avance medido se conserva el porcentaje real. B corresponde a esperas indeterminadas; no se inventa progreso.</p>
    </div>
  </section>
}
