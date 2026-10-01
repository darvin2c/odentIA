# Composición de interfaz

Objetivo: convertir primitivas en recorridos y superficies coherentes, sin datos ni permisos de negocio dentro del patrón. Consultar la skill `odentia-ux` para el método de diseño/verificación.

- Pantallas con `PageShell` + `PageHeader`; no anidar shells si el layout ya lo aporta.
- `PageHeader`: único h1, subtítulo y acciones; banda `bg-card` sin borde ni sombra. Utilidades globales mediante `HeaderUtilitiesProvider`, separadas de acciones; en móvil envuelven antes de recortar el título.
- `AppShell` sin topbar adicional ni buscador global. Sidebar expandido con marca/colapso; colapsado con marca compacta que permite expandir, tooltip y control accesible; drawer móvil desde `PageHeader`.
- Búsqueda por lista con `FilterBar`/`SearchInput`. Formularios con `FormDrawer`/`FormPanel` + `SubmitButton`; tablas con `DataTable`; métricas con `KpiCard`; estados con `EmptyState`/`LoadingState`/`ErrorState`.
- Separar acciones globales, de página y de registro. Acciones secundarias bajo demanda, sin esconder la tarea principal ni acciones necesarias para teclado.
- Feedback distingue guardando, confirmado y revertido. No prometer éxito antes de respuesta; proteger borradores y restaurar foco al cerrar overlays.
- Gráficos mediante `FunnelChart`, `DonutChart`, `TrendChart` y `BarChart`; el renderer base vive en `ui`. Las apps no importan la librería de gráficos.
- Nuevas composiciones compartidas se estrenan como stories junto al componente; shell en `src/app-shell.stories.tsx`. Mostrar estados relevantes y contenido realista, no solo el estado ideal.
- Stories y código son la referencia concreta de variantes y medidas; no duplicarlas en una especificación Markdown. Verificación visual real en escritorio/móvil, teclado y movimiento reducido cuando haya animaciones.
