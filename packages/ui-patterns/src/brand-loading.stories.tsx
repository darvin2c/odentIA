import { Badge, Button, Field, FieldLabel, Spinner, Textarea } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Brand } from "./brand.js"
import { useDemoRequest, type DemoSettings } from "./brand-loading-demo.js"
import { TableScene } from "./brand-loading-table-demo.js"
import { FieldsScene, MoreAndPreviewScene } from "./brand-loading-fields-demo.js"
import { DetailDrawer } from "./detail/detail-drawer.js"
import { ErrorState } from "./error-state.js"
import { SubmitButton } from "./form/submit-button.js"
import type { DemoPatient } from "./story-fixtures.js"
import "./brand-loading.stories.css"

const meta = {
  title: "Identidad/Cargas",
  parameters: { layout: "fullscreen" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function SaveScene({ settings }: { settings: DemoSettings }) {
  const save = useDemoRequest(settings)
  const file = useDemoRequest(settings)
  const [note, setNote] = useState("Contactar por la tarde para coordinar la próxima visita.")
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  function download() {
    setDownloaded(false)
    file.run(() => {
      const url = URL.createObjectURL(new Blob(["Demostración de loading de Odentia32. No contiene datos clínicos reales.\n"], { type: "text/plain;charset=utf-8" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "odentia32-demo-carga.txt"
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setDownloaded(true)
    }, "No se generó el archivo de demostración. Puedes volver a solicitarlo.")
  }
  return <section className="loading-flow-card" aria-labelledby="actions-scene-title">
    <div className="loading-flow-card-heading"><div><h2 id="actions-scene-title">04 · Botones y borradores</h2><p>Se mantiene el texto del botón y se bloquea solo la acción pendiente. Un error no borra lo escrito.</p></div></div>
    <form onSubmit={event => { event.preventDefault(); const submitted = note; save.run(() => setSavedNote(submitted), "Guardado rechazado en la simulación: no se aplicaron cambios. Tu borrador sigue aquí.") }}>
      <Field><FieldLabel htmlFor="loading-demo-note">Nota operativa de demostración</FieldLabel><Textarea id="loading-demo-note" value={note} disabled={save.busy} onChange={event => setNote(event.target.value)} rows={3} /></Field>
      <div className="loading-flow-actions"><SubmitButton type="submit" pending={save.busy} disabled={!note.trim()}>Guardar cambios</SubmitButton><SubmitButton type="button" variant="outline" pending={file.busy} onClick={download}>Descargar ejemplo</SubmitButton></div>
    </form>
    <p className="loading-flow-status" role="status" aria-live="polite">{save.busy ? "Guardando el borrador… Botón bloqueado para evitar envíos duplicados." : savedNote && !save.error ? `Guardado solo en esta demo: ${savedNote}` : "Nada se envía a la clínica."}</p>
    {save.error && <p className="loading-flow-error" role="alert">{save.error}</p>}
    <p className="loading-flow-status" role="status" aria-live="polite">{file.busy ? "Preparando archivo de ejemplo…" : downloaded ? "Archivo de demostración generado y descarga solicitada." : null}</p>
    {file.error && <p className="loading-flow-error" role="alert">{file.error}</p>}
  </section>
}

function DetailScene({ patient, cachedVersion, settings, dark, paused, onClose, onCache }: { patient: DemoPatient; cachedVersion: number; settings: DemoSettings; dark: boolean; paused: boolean; onClose: () => void; onCache: (id: string, version: number) => void }) {
  const request = useDemoRequest(settings)
  const initialVersion = useRef(cachedVersion)
  const versionRef = useRef(cachedVersion)
  const [version, setVersion] = useState(cachedVersion)
  const load = useCallback(() => request.run(() => {
    const next = versionRef.current + 1
    versionRef.current = next
    setVersion(next)
    onCache(patient.id, next)
  }, "No se recibió el detalle de demostración. El contexto ya cargado no se elimina."), [request.run, onCache, patient.id])
  useEffect(() => { if (initialVersion.current === 0) load() }, [load])
  return <DetailDrawer open onClose={onClose} title={patient.name} description="Persona sintética · primera apertura con skeleton; actualización con B." className={dark ? "dark loading-flow-detail" : "loading-flow-detail"} closeLabel="Cerrar detalle"
    isLoading={version === 0 && !request.error}
    actions={<span data-spinner-paused={paused}><SubmitButton pending={version > 0 && request.busy} disabled={version === 0} variant="outline" onClick={load}>Actualizar detalle</SubmitButton></span>}>
    <div className="loading-flow-detail-content">
      <p role="status" className="loading-flow-status">{request.busy ? "Actualizando detalle; los datos siguen visibles…" : version > 0 ? `Respuesta demo ${version}. Al reabrir se conserva este contexto.` : "Todavía no hay un detalle disponible."}</p>
      {request.error && <ErrorState title="No se pudo consultar el detalle" message={request.error} onRetry={load} retryLabel="Reintentar detalle" />}
      {version > 0 && <dl className="loading-flow-record"><div><dt>Persona</dt><dd>{patient.name}</dd></div><div><dt>Historia</dt><dd>{patient.patientNumber}</dd></div><div><dt>Teléfono</dt><dd>{patient.phone ?? "Sin teléfono"}</dd></div><div><dt>Canales</dt><dd>{patient.channels.join(", ") || "Sin canales"}</dd></div></dl>}
    </div>
  </DetailDrawer>
}

function ContextScene({ settings }: { settings: DemoSettings }) {
  const request = useDemoRequest(settings)
  const [organization, setOrganization] = useState("Clínica Norte")
  const [target, setTarget] = useState("Clínica Sur")
  function changeContext() {
    const next = organization === "Clínica Norte" ? "Clínica Sur" : "Clínica Norte"
    setTarget(next)
    request.run(() => setOrganization(next), "No se pudo abrir el contexto de demostración. No se ha confirmado el cambio de organización.")
  }
  return <section className="loading-flow-card" aria-labelledby="context-scene-title">
    <div className="loading-flow-card-heading"><div><h2 id="context-scene-title">05 · Espera sin estructura disponible</h2><p>Al resolver acceso o contexto todavía no hay una tabla que anticipar. Aquí sí cabe B centrada; nunca datos de una clínica bajo el nombre de otra.</p></div></div>
    <Button variant="outline" disabled={request.busy} onClick={changeContext}>Cambiar organización (demo)</Button>
    <div className="loading-flow-context" aria-busy={request.busy}>
      {request.busy ? <div className="loading-flow-context-wait" role="status"><span className="loading-flow-brand-color"><Spinner aria-hidden="true" className="size-16" /></span><p>Abriendo {target}…</p><small>Esperando contexto. No mostramos información de otra organización.</small></div> : <div><Badge variant="secondary">Contexto demo</Badge><h3>{organization}</h3><p>Área de trabajo de demostración, sin datos reales.</p></div>}
    </div>
    {request.error && <ErrorState title="No se cambió de organización" message={request.error} onRetry={changeContext} retryLabel="Reintentar cambio de contexto" />}
  </section>
}

function LoadingFlows({ initiallyDark = false }: { initiallyDark?: boolean }) {
  const [dark, setDark] = useState(initiallyDark)
  const [fail, setFail] = useState(false)
  const [slow, setSlow] = useState(false)
  const [paused, setPaused] = useState(false)
  const [selected, setSelected] = useState<DemoPatient | null>(null)
  const [cache, setCache] = useState<Record<string, number>>({})
  const onCache = useCallback((id: string, version: number) => setCache(previous => ({ ...previous, [id]: version })), [])
  const settings = { fail, slow }
  return <div className={dark ? "dark" : ""}>
    <main className="loading-flows bg-canvas text-foreground" data-spinner-paused={paused}>
      <header className="loading-flow-heading"><Brand /><div><h1>Cargas con identidad · Variante B</h1><p>Presentación interactiva, no integración en producción. Datos sintéticos y respuestas simuladas; ninguna operación contacta servicios reales.</p></div></header>
      <div className="loading-flow-controls" aria-label="Controles de demostración">
        <Button variant="outline" aria-pressed={dark} onClick={() => setDark(!dark)}>Modo oscuro</Button>
        <Button variant="outline" aria-pressed={slow} onClick={() => setSlow(!slow)}>Respuesta lenta (5 s)</Button>
        <Button variant="outline" aria-pressed={fail} onClick={() => setFail(!fail)}>Simular errores</Button>
        <Button variant="outline" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Reanudar animación" : "Pausar animación"}</Button>
      </div>
      <p className="loading-flow-demo-note">La demora solo permite observar esta story; no se impondría en la aplicación. Velocidad y errores se aplican a las operaciones que inicies después.</p>
      <div className="loading-flow-rules"><p><strong>Sin datos y con estructura conocida:</strong> skeleton.</p><p><strong>Recarga automática:</strong> B en el estado de la tabla; conservar filas y separar guardado de sincronización.</p><p><strong>Búsqueda:</strong> B dentro del input; seguir escribiendo y descartar respuestas antiguas.</p></div>
      <TableScene settings={settings} onOpen={setSelected} dark={dark} paused={paused} />
      <div className="loading-flow-secondary-grid"><FieldsScene settings={settings} dark={dark} /><MoreAndPreviewScene settings={settings} dark={dark} /></div>
      <div className="loading-flow-secondary-grid"><SaveScene settings={settings} /><ContextScene settings={settings} /></div>
      <p className="loading-flow-demo-note">La marca de cabecera permanece estática. Casos revisados del repositorio: invalidación tras guardar, eventos y reconexión; búsqueda con debounce de 300 ms; opciones dependientes; «Cargar más»; archivos y documentos. Esta story no cambia producción. B indica espera indeterminada, no un porcentaje ni que una acción haya terminado.</p>
    </main>
    {selected && <DetailScene key={selected.id} patient={selected} cachedVersion={cache[selected.id] ?? 0} settings={settings} dark={dark} paused={paused} onClose={() => setSelected(null)} onCache={onCache} />}
  </div>
}

export const Recorridos: Story = { render: () => <LoadingFlows /> }
export const RecorridosOscuros: Story = { render: () => <LoadingFlows initiallyDark /> }
