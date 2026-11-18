import { Button, Field, FieldLabel, Input, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Spinner } from "@odentia/ui"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Search, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { useDemoRead, useDemoRequest, type DemoSettings } from "./brand-loading-demo.js"
import { DataTable, DataTableSkeleton } from "./data-table.js"
import { EmptyState } from "./empty-state.js"
import { ErrorState } from "./error-state.js"
import { FormDrawer } from "./form/form-drawer.js"
import { SubmitButton } from "./form/submit-button.js"
import { DEMO_PATIENTS, type DemoPatient } from "./story-fixtures.js"

type Query = { page: number; search: string }
type Operation = "initial" | "refresh" | "search" | "previous" | "next" | "automatic"
type Snapshot = { query: Query; rows: DemoPatient[]; total: number }
type Editor = { original: DemoPatient | null; name: string; phone: string }
const FIRST: Query = { page: 1, search: "" }
const PAGE_SIZE = 3
const EMPTY_ROWS: DemoPatient[] = []
const scope = (query: Query) => `${query.search ? `Búsqueda «${query.search}»` : "Todos los pacientes"} · página ${query.page}`

/** Almacén sintético y transporte local, únicamente para comprobar el recorrido en Storybook. */
export function TableScene({ settings, onOpen, dark, paused }: { settings: DemoSettings; onOpen: (patient: DemoPatient) => void; dark: boolean; paused: boolean }) {
  const read = useDemoRead(settings)
  const mutation = useDemoRequest(settings)
  const [store] = useState(() => ({ rows: DEMO_PATIENTS.map(row => ({ ...row })), nextId: 100, events: 0 }))
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [search, setSearch] = useState("")
  const [attempt, setAttempt] = useState<{ query: Query; kind: Operation }>({ query: FIRST, kind: "initial" })
  const intended = useRef(FIRST)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null)
  const [failSync, setFailSync] = useState(false)
  const load = useCallback((query: Query, kind: Operation, fail?: boolean) => {
    intended.current = query
    setAttempt({ query, kind })
    read.run(() => {
      const matches = store.rows.filter(row => row.name.toLocaleLowerCase("es").includes(query.search.toLocaleLowerCase("es")))
      const page = Math.min(query.page, Math.max(1, Math.ceil(matches.length / PAGE_SIZE)))
      setSnapshot({ query: { ...query, page }, rows: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: matches.length })
    }, "No se pudo actualizar la lista de demostración. Conservamos los últimos datos recibidos.", { debounce: kind === "search" ? 300 : 0, fail })
  }, [read.run, store])
  useEffect(() => { load(FIRST, "initial") }, [load])
  const changingQuery = read.busy && !!snapshot && (attempt.query.search !== snapshot.query.search || attempt.query.page !== snapshot.query.page)
  const controlsBlocked = read.busy || mutation.busy
  const columns: ColumnDef<DemoPatient>[] = [
    { accessorKey: "name", header: "Persona", meta: { view: { role: "title" } } },
    { accessorKey: "patientNumber", header: "Historia", meta: { view: { primary: true } } },
    { accessorKey: "phone", header: "Teléfono", cell: ({ getValue }) => getValue<string | null>() ?? "Sin teléfono" },
    { id: "actions", header: "Acciones", meta: { view: { role: "actions" } }, cell: ({ row }) => <span className="loading-flow-row-actions"><Button variant="ghost" size="sm" disabled={changingQuery} onClick={() => onOpen(row.original)} aria-label={`Ver detalle de ${row.original.name}`}>Ver detalle</Button><Button variant="ghost" size="sm" disabled={controlsBlocked} onClick={() => { mutation.clearError(); setSaved(null); setEditor({ original: row.original, name: row.original.name, phone: row.original.phone ?? "" }) }} aria-label={`Editar ${row.original.name}`}>Editar</Button></span> },
  ]
  const table = useReactTable({ data: snapshot?.rows ?? EMPTY_ROWS, columns, getCoreRowModel: getCoreRowModel() })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!editor?.name.trim()) return
    const draft = editor
    mutation.run(() => {
      const id = draft.original?.id ?? `demo-${store.nextId++}`
      if (draft.original) store.rows = store.rows.map(row => row.id === id ? { ...row, name: draft.name.trim(), phone: draft.phone.trim() || null } : row)
      else store.rows = [{ id, name: draft.name.trim(), phone: draft.phone.trim() || null, patientNumber: 2000 + store.nextId, docNumber: null, age: 30, channels: [], lastVisit: null, tags: [], isActive: true }, ...store.rows]
      setSaved({ id, name: draft.name.trim() })
      setEditor(null)
      load(intended.current, "automatic", failSync ? true : undefined)
    }, "Guardado rechazado en la demostración. No se modificó el registro; conservamos tu borrador.")
  }
  function externalChange() {
    store.events += 1
    store.rows = store.rows.map((row, index) => index === 0 ? { ...row, phone: `Anexo demo ${store.events}` } : row)
    setSaved(null)
    load(intended.current, "automatic", failSync ? true : undefined)
  }
  const pages = snapshot ? Math.max(1, Math.ceil(snapshot.total / PAGE_SIZE)) : 1
  return <section className="loading-flow-card" aria-labelledby="table-scene-title">
    <div className="loading-flow-card-heading"><div><h2 id="table-scene-title">01 · Tabla y actualizaciones automáticas</h2><p>Guardar y recibir la lista nueva son dos operaciones. Las filas no desaparecen mientras se sincronizan.</p></div><Button disabled={controlsBlocked || !snapshot} onClick={() => { mutation.clearError(); setSaved(null); setEditor({ original: null, name: "", phone: "" }) }}>Nuevo registro</Button></div>
    <div className="loading-flow-demo-controls" role="group" aria-label="Controles de la demo de tabla">
      <Button variant="outline" size="sm" disabled={controlsBlocked} onClick={() => { setSnapshot(null); setSearch(""); setSaved(null); load(FIRST, "initial") }}>Repetir primera carga</Button>
      <Button variant="outline" size="sm" disabled={controlsBlocked || !snapshot} onClick={externalChange}>Simular evento externo</Button>
      <Button variant="outline" size="sm" aria-pressed={failSync} onClick={() => setFailSync(!failSync)}>Fallar recarga tras guardar</Button>
    </div>
    {saved && <p className="loading-flow-save-confirmed" role="status"><strong>Guardado confirmado (demo): {saved.name}.</strong> {read.busy ? "La lista aún está sincronizando." : read.error ? "No vuelvas a guardar: falló solo la actualización de la lista." : "La consulta visible ya recibió su respuesta; el registro puede quedar fuera del filtro o página actuales."}</p>}
    <div className="loading-flow-toolbar">
      <Field className="loading-flow-search"><FieldLabel htmlFor="loading-demo-search">Buscar pacientes (demo)</FieldLabel>
        <InputGroup><InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon><InputGroupInput id="loading-demo-search" type="search" value={search} onChange={event => { setSearch(event.target.value); load({ page: 1, search: event.target.value.trim() }, "search") }} placeholder="Escribe para buscar…" aria-describedby="loading-search-feedback" aria-busy={attempt.kind === "search" && read.phase === "loading"} /><InputGroupAddon align="inline-end">{attempt.kind === "search" && read.phase === "loading" && <span className="loading-flow-brand-color"><Spinner aria-hidden="true" style={{ width: 22, height: 22 }} /></span>}{search && <InputGroupButton aria-label="Limpiar búsqueda de pacientes" onClick={() => { setSearch(""); load(FIRST, "search") }}><X aria-hidden="true" /></InputGroupButton>}</InputGroupAddon></InputGroup>
      </Field>
      <SubmitButton variant="outline" pending={read.busy && attempt.kind === "refresh"} disabled={controlsBlocked || !snapshot} onClick={() => load(intended.current, "refresh")}>Actualizar tabla</SubmitButton>
    </div>
    <div className="loading-flow-table-state" role="status" aria-live="polite" id="loading-search-feedback">
      <span>{snapshot ? `${snapshot.total} personas · ${scope(snapshot.query)}` : "Cargando lista por primera vez…"}</span>
      {attempt.kind === "automatic" && read.busy ? <span className="loading-flow-auto-refresh"><span className="loading-flow-brand-color"><Spinner aria-hidden="true" className="size-6" /></span>Sincronizando lista…</span> : attempt.kind === "search" && read.busy ? <span>{read.phase === "debounce" ? "Esperando a que termines de escribir…" : `Buscando ${attempt.query.search ? `«${attempt.query.search}»` : "todos los pacientes"}…`}</span> : null}
    </div>
    {read.error && <ErrorState title={saved ? "Registro guardado; lista pendiente de actualizar" : "No se pudo consultar la lista"} message={read.error} onRetry={() => load(intended.current, "automatic")} retryLabel="Reintentar solo la lista" />}
    {snapshot ? <>
      {changingQuery && <p className="loading-flow-current-view">Resultados anteriores: {scope(snapshot.query)}. Pendiente: {scope(attempt.query)}. Las acciones de estas filas esperan la respuesta nueva.</p>}
      <div aria-busy={read.busy} data-testid="loading-table-content">{snapshot.rows.length > 0 ? <DataTable table={table} /> : <EmptyState title="Sin coincidencias" description="La consulta terminó sin resultados. Cambia el texto de búsqueda." />}</div>
      <div className="loading-flow-pagination"><span>Página {snapshot.query.page} de {pages}</span><SubmitButton variant="outline" pending={read.busy && attempt.kind === "previous"} disabled={controlsBlocked || snapshot.query.page <= 1} onClick={() => load({ ...snapshot.query, page: snapshot.query.page - 1 }, "previous")}>Página anterior</SubmitButton><SubmitButton variant="outline" pending={read.busy && attempt.kind === "next"} disabled={controlsBlocked || snapshot.query.page >= pages} onClick={() => load({ ...snapshot.query, page: snapshot.query.page + 1 }, "next")}>Página siguiente</SubmitButton></div>
    </> : !read.error ? <DataTableSkeleton rowCount={3} columnCount={4} label="Cargando personas por primera vez" /> : null}
    {editor && <FormDrawer open onClose={() => setEditor(null)} title={editor.original ? "Editar registro de demostración" : "Nuevo registro de demostración"} description="Solo cambia el almacén de esta story. Tras guardar se recarga la lista por separado." className={dark ? "dark loading-flow-detail" : "loading-flow-detail"} onSubmit={submit} isSubmitting={mutation.busy} isDirty={editor.name !== (editor.original?.name ?? "") || editor.phone !== (editor.original?.phone ?? "")} error={mutation.error} hideSubmit>
      <Field><FieldLabel htmlFor="loading-record-name">Nombre del registro</FieldLabel><Input id="loading-record-name" autoComplete="off" required disabled={mutation.busy} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor="loading-record-phone">Teléfono (demo)</FieldLabel><Input id="loading-record-phone" disabled={mutation.busy} value={editor.phone} onChange={event => setEditor({ ...editor, phone: event.target.value })} /></Field>
      <div data-spinner-paused={paused}><SubmitButton type="submit" pending={mutation.busy} disabled={!editor.name.trim()}>Guardar registro</SubmitButton></div>
    </FormDrawer>}
  </section>
}
