# Presentación Fundadores de latidIA

Presentación animada para los consultorios médicos que entran primero al programa Fundadores. Es la de odentIA (`../founders`), pensada para un consultorio: diez problemas, cada uno con la respuesta de latidIA; los agentes Sofi, Clío y Argos; el precio de consultorio fundador y cómo entrar. Se presenta con clics: cada parte muestra primero el problema y, con un clic, la respuesta. Tiene guion para quien presenta (tecla N).

Usa los datos de la demo de la web: el Consultorio San Martín, la Dra. Elena Vela y sus pacientes Rosa, Luis y Julia, más Carla para la señal de alarma.

## Armarla

```bash
node assets/presentations/founders-latidia/build.mjs
```

Deja `dist/founders-latidia.html`, un solo archivo que se abre en el navegador. Necesita internet para las fuentes y para three.js. `dist/` no se guarda en git.

## Qué hay aquí

- `source.html`: las 16 partes, los estilos, las escenas y el guion. Tiene cuatro marcadores que llena el armado: `%%LOGO%%`, `%%ECG%%`, `%%COVER%%` y `%%LATIDO%%`.
- `cover-3d.js`: la portada en three.js. Es la línea de pulso de la marca, tres latidos a 72 por minuto; en cada pico se abre un anillo del color de un agente.
- `latido-3d.js`: la parte 5, «Conoce a tus agentes». Muestra los corchetes del [72] de cada agente; el caso de Rosa es un latido que pasa de un agente a otro.
- `build.mjs`: arma el archivo. La línea de pulso sale de la portada de la web (`apps/web/src/components/latidia/home/DictationDemo.tsx`) y el logotipo de `apps/web/src/assets`. Un cambio en la web llega aquí cuando se vuelve a armar.

## Reglas

- Solo piezas de la marca: la línea de pulso y los corchetes. Nada de dientes ni de objetos genéricos.
- Cada agente lleva su color en todo lo que hace: Sofi celeste, Clío menta y Argos ámbar. Lo demás va en lila.
- Las cifras de ejemplo van marcadas como «Ejemplo». Antes de presentar hay que confirmar contra producción las cifras del plan Fundadores y el enlace del botón: precios por tipo de la ADR 0085 y `latidia72.com/solicitar-invitacion`.
