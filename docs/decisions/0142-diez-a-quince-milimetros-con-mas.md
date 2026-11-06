# 0142 · 10 a 15 mm se escriben con «+», sin plazo de tiempo

Fecha: 2026-11-05 · Estado: aceptada · Precisa [0054](0054-el-periodontograma-vive-en-la-atencion.md) («La pantalla sigue a la sonda»)

## Problema

El 0054 dejó que 10 a 15 mm se escribieran con los dos dígitos seguidos, en menos de 0,8 s, para no frenar los sitios de un dígito. En la ronda de QA del 2026-11-04 (X1) se midió con el código real (`capture-state.ts`), tecleando al ritmo de un dictado (0,3 a 0,6 s entre teclas) las dos visitas del paciente de la demo:

- se unieron entre 36 y 49 pares de cifras por boca;
- «2 1 2» quedaba 2 y 12, y todo lo que seguía se corría un sitio, con la propuesta de estadio cambiada sin aviso;
- quien teclea despacio o usa un lector de pantalla no podía escribir 12 (WCAG 2.1.1: el teclado no debe exigir un ritmo);
- la recesión de −10, que la base acepta, no se podía escribir.

El 1 mm es lo normal en una encía sana y los 10 a 15 mm son raros: la carga tenía que caer en lo raro.

## Decisión y motivo

El usuario lo aceptó el 2026-11-05 (pregunta 13):

- **«1» es siempre 1**, y cada cifra va a su sitio en cuanto se pulsa. La captura ya no mira el reloj.
- **10 a 15 se escriben con «+» y la segunda cifra:** «+» y «2» es 12. En el teclado de la pantalla es el botón «+10». Cuesta lo mismo que antes: dos teclas.
- **«+» otra vez o ⌫** lo deshacen sin borrar nada. Moverse o saltar la pieza también lo deshacen.
- **Más de 15, o una recesión menor que −10,** se dice («La profundidad va de 0 a 15 mm») y no se escribe nada.
- **La recesión de −10** se escribe con «−», «+» y 0.
- **El campo muestra «1…»** mientras espera la segunda cifra, y el lector de pantalla dice «Más 10: escribe la segunda cifra, de 10 a 15».

Es lo que hacen otros programas: ninguno de los revisados junta cifras por tiempo. Dentrix usa «−», EXACT «+» y Dentally «d» antes de la cifra; Open Dental y SoftDent tienen un botón «10».

## Alternativas descartadas

- *Alargar el plazo:* reduce el error, pero sigue exigiendo un ritmo y sigue uniendo cifras de quien teclea rápido.
- *Una tecla después de la cifra* («1» y luego «+»): obliga a esperar para saber si el 1 es 1, que es el problema de hoy.

## Consecuencias

- Una boca sana o con bolsas de un dígito se escribe igual que antes; los 10 a 15 mm piden pensar una tecla antes.
- Las pruebas escriben al ritmo que sea: la unitaria no usa reloj y la de recorrido teclea «3 1 2» seguido.

## Referencias

- `apps/dental-clinic/src/components/dental/periodontal/capture-state.ts` (`applyCaptureKey`, `keyFromEvent`), `periodontal-capture.tsx` (el botón «+10»).
- `odentia-qa/2026-11-04-completo/estudio-x1-periodontograma.md` (la medición).
