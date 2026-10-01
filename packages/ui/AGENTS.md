# Primitivas de interfaz

Objetivo: controles accesibles, consistentes y reutilizables sin dependencias del negocio ni de las apps.

- Reutilizar tokens del tema, variantes existentes y semántica nativa. No fijar colores por pantalla ni duplicar controles existentes.
- Teclado, foco visible, nombres accesibles y estados disabled/error forman parte del contrato. Respetar `prefers-reduced-motion`.
- Composiciones de páginas/formularios pertenecen a `ui-patterns`; datos, navegación de negocio y permisos pertenecen a apps.
- `ChartContainer` encapsula `@tanstack/charts`, fijado exactamente en `0.18.0` por su API alpha. Renderer SVG y SSR seguro; no actualizar automáticamente entre minors.
- Gráficos con `title` y `summary`, colores `--chart-1..5` y tema oscuro. No probar geometría SVG mediante jsdom: verificar stories en navegador.
- Scroll de paneles/tableros mediante `ScrollArea` (horizontal cuando corresponda); no introducir un segundo sistema de scroll para el mismo patrón.
