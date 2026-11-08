# 0159 · Lo que se cobra por sesión no se carga antes desde el presupuesto

Fecha: 2026-11-08 · Estado: aceptada · Precisa un punto de ADR 0155 (lo adelantado de un servicio que se cobra por sesión).

## Problema

Un servicio que se cobra por sesión genera su cargo al firmar cada visita (`finalizeEncounter`): un cargo por visita, al precio de la sesión y hasta las visitas previstas. La API también dejaba crear un cargo desde la línea de presupuesto de ese servicio antes de la visita (`createCharge` con `budgetItemId`). Firmar la visita no miraba ese cargo, porque solo cuenta los cargos de visitas, y volvía a cargar la misma sesión: al paciente se le debía dos veces. Esos cargos tampoco tenían tope: solo contaban las visitas cobradas. Ninguna pantalla ni ningún agente crea ese cargo; solo pasaba por la API.

## Decisión y motivo

`createCharge` rechaza el cargo desde una línea que se cobra por sesión (`CHARGED_PER_VISIT`, 409, junto a `budgetItemId`). La deuda de cada sesión nace solo al firmar su visita. Si la persona paga antes, ese dinero es un adelanto a favor (`collectCharge` con `advanceCents`) y cancela el cargo de la visita al cobrarlo. La comisión es la de ese cobro, de quien hizo la visita y con la regla del día de la atención, como cualquier visita. Así no hace falta enseñarle a `commission_live` qué sesión cubre cada adelanto.

Es la misma operación para la API, las pantallas y los agentes, y no cambia nada que hoy se vea.

## Alternativas descartadas

- **Dejar el cargo adelantado y que firmar la visita lo dé por cubierto.** Habría que decidir qué sesión cubre cada adelanto y qué pasa con uno parcial o anulado. También habría que enseñarle a `commission_live` a dar cada adelanto a la sesión que cubrió, no a la primera, con su mes, para no reabrir uno ya pagado. Era otra regla de dinero, con su migración de la vista, para un camino que ninguna pantalla usa.
- **Ponerle tope a esos cargos sin cambiar la firma.** Seguía cobrando dos veces la sesión adelantada.

## Consecuencias

- Lo que se cobra por tratamiento no cambia: su cargo adelantado sigue repartiendo la comisión entre sus sesiones (ADR 0155).
- Un cargo de este tipo creado antes por la API seguiría cargándose otra vez al firmar. Se revisa al desplegar con una lectura de la base. Si aparece alguno, se resuelve a mano con caja, caso por caso.
- Se revisaría si una pantalla necesitara vender un paquete de sesiones con su propio cargo. Entonces cada adelanto tendría que unirse a la visita que cubre.

## Referencias

- `packages/services/src/payments.ts` (`createCharge`), `encounters.ts` (`finalizeEncounter`)
- `packages/db/drizzle/0060_comision_en_su_moneda_reglas.sql` (`commission_live`)
- `packages/services/src/session-billing.test.ts`, `finance-commission-currency.test.ts`
