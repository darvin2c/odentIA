/**
 * Catálogo de copy compartido es-PE. Antes venía de un paquete externo;
 * ahora vive en @odentia/ui-patterns. Todas las claves usadas por los
 * componentes del paquete; consumidores importan { common } del barrel.
 */
export const common = {
  actions: {
    cancel: "Cancelar",
    save: "Guardar",
    retry: "Reintentar",
    close: "Cerrar",
  },
  states: {
    loading: "Cargando…",
    refreshing: "Actualizando…",
    empty: "Sin resultados",
    emptyHint: "No hay nada para mostrar todavía.",
    error: "Algo salió mal",
  },
  errors: {
    generic: "Ocurrió un error inesperado. Inténtalo de nuevo.",
  },
  labels: {
    code: "Código",
    requestId: "ID de solicitud",
  },
  phone: {
    country: "País",
    placeholder: "Número de teléfono",
  },
  timeZone: {
    label: "Zona horaria",
    search: "Buscar ciudad o zona horaria…",
    empty: "Sin coincidencias",
  },
  confirm: {
    unsavedMessage: "Tienes cambios sin guardar. ¿Deseas descartarlos?",
  },
  filters: {
    today: "Hoy",
    last3Days: "Últimos 3 días",
    last7Days: "Últimos 7 días",
    last30Days: "Últimos 30 días",
    previous: "Anterior",
    next: "Siguiente",
    search: "Buscar",
    moreFilters: "Más filtros",
    label: "Filtros",
    clear: "Limpiar",
    noResults: "Sin resultados",
    min: "Mín",
    max: "Máx",
    sort: "Ordenar",
    sortDefault: "Predeterminado",
  },
  views: {
    selectAll: "Seleccionar todo",
  },
  agenda: {
    today: "Hoy",
    previous: "Anterior",
    next: "Siguiente",
    view: "Vista",
    free: "Hueco libre",
    unavailable: "No disponible",
    noEntries: "Sin citas",
    more: "más",
  },
} as const
