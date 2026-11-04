# El CI prueba lo que cambia

Fecha: 2026-11-04 · Estado: aceptada · Relacionada con [0136](0136-las-webs-de-marketing-en-cloudflare-workers.md), [0137](0137-panel-y-administracion-en-cloudflare-workers.md) y [0138](0138-la-app-de-las-clinicas-en-cloudflare-workers.md); reemplaza la frase «el PR prueba todo» de la sección «CI y despliegue automático» de `docs/deployment.md`

## Problema

Cada PR corría la batería completa: siete partes de pruebas, tres de E2E y la imagen, aunque el cambio fuera una skill o una línea de la web. Un PR de documentación esperaba detrás de otro, y uno de código tardaba más de cincuenta minutos entre colas y repeticiones. El CI tiene que responder en minutos a lo que cambió y no pagar por lo que no tocó, sin dejar pasar una regla que se rompe en otro paquete.

## Decisión y motivo

- **Un cambio solo de documentación o skills** (`docs/`, `.agents/`, `.claude/skills/`, `AGENTS.md`, `README.md`) **no corre nada** y no despliega.
- **Un cambio de código corre lo que depende de él.** Turbo calcula los paquetes afectados (el cambiado y todos los que lo usan). Solo esos se tipan y se prueban; PostgreSQL se levanta solo si alguno de ellos lo necesita.
- **E2E corre si el cambio toca algo más que la web de marketing.** La web no tiene recorridos E2E.
- **La imagen y el deploy al VPS corren solo si cambian `api` o `worker`**, o lo que dependen de ellos: la imagen de producción sirve esos dos servicios.
- **Las webs de Cloudflare se arman y publican solo si la app cambia.**
- **Un archivo fuera de `apps/`, `packages/` y `e2e/`** (CI, Dockerfile, compose, infraestructura, raíz, lockfile) **corre todo**: no se sabe qué toca.
- **Las reglas que leen el repositorio entero** (límites entre productos, rutas de la ayuda, pantallas con ScrollArea) corren en su propio job `arquitectura` en cada cambio de código. Así una regla no queda sin correr porque su paquete no cambió.
- Si no se puede calcular la base, **corre todo**. Falla hacia lo seguro.

La lógica vive en `scripts/ci-alcance.mjs`, que se puede probar en local.

## Alternativas descartadas

- *Batería completa en cada PR*: es lo que tardaba más de cincuenta minutos.
- *Filtros por ruta a mano en el workflow*: cada paquete nuevo o cada dependencia nueva habría que anotarla a mano, y el grafo de Turbo ya la conoce.
- *Probar solo lo afectado sin el job de reglas*: deja pasar reglas que leen otros paquetes; ese fue el motivo del CI completo.

## Consecuencias

- Un cambio de una app tarda lo que tarda su parte, no la suma de todas.
- Un paquete compartido sigue activando a todos sus dependientes; eso es correcto y costará más en un cambio de `services`.
- La anotación `ci/codigo-probado` vale para lo que corrió. Lo que se saltó por no aplicar cuenta como correcto; un fallo no. Al unir, `main` despliega sin repetir las pruebas solo si su árbol coincide con el probado.
- Revisar esta decisión si aparece un fallo en `main` que las partes afectadas no detectaron: el primer paso sería añadir la regla a `arquitectura` o ampliar el alcance de ese paquete, no volver a la batería completa por defecto.

## Referencias

- `.github/workflows/ci.yml`: jobs `alcance`, `arquitectura`, `check`, `e2e`, `docker-build`, `deploy`, `deploy-web`, `codigo-probado`.
- `scripts/ci-alcance.mjs`: reglas de alcance y su salida.
