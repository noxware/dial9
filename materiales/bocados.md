# Bocados sobre Dial9

## Cómo nació

- Russell Cohen estaba ayudando con un componente Rust cuyo problema de rendimiento sólo aparecía a escala de producción.
- Ya había métricas, pero no alcanzaban para reconstruir qué había ocurrido ni en qué orden.
- Necesitaban registrar una línea de tiempo detallada sin afectar significativamente al servicio.
- Al analizar la primera traza, encontraron demoras frecuentes de más de 10 ms causadas por el scheduling del sistema operativo.
- Esa necesidad concreta fue el origen de Dial9.

## Una definición corta

- Dial9 es una **caja negra** para aplicaciones Rust: registra lo que ocurre y permite analizarlo después.
- También puede describirse como un **microscopio**: junta información de la aplicación, Tokio y el sistema operativo.
- A diferencia de una métrica agregada, conserva eventos individuales y su orden.
- Está pensado para investigar problemas difíciles de reproducir fuera de producción.

## Qué puede registrar

- Actividad del runtime de Tokio.
- Samples de CPU y memoria.
- Información del sistema operativo.
- Spans, métricas y eventos propios de la aplicación.
- Se puede habilitar sólo lo necesario para cada caso.

## Por qué tiene que ser barato

- Una aplicación puede producir cientos de miles de eventos por segundo.
- La telemetría no debería convertirse en el nuevo problema de rendimiento.
- Dial9 usa un formato binario compacto y mueve el procesamiento pesado fuera del camino principal de la aplicación.
- Si no puede seguir el ritmo, prioriza la aplicación y descarta datos de profiling antes que bloquearla.

## Historia pública

- El primer commit visible del repositorio es de Russell Cohen y data del 23 de febrero de 2026.
- El blog oficial de Tokio publicó su presentación de Dial9 el 18 de marzo de 2026.
- Carl Lerche invitó a Russell a escribir esa publicación y a presentar una demo en TokioConf.
- En junio apareció una segunda publicación enfocada en cómo se registra y transporta tanta información.

## Dial9 0.5

- `dial9` pasó a ser el único crate de entrada para las funcionalidades principales.
- El recorder dejó de depender de Tokio: Tokio es ahora una integración opcional.
- Esto permite usar CPU profiling, memoria y eventos propios también en aplicaciones Rust que no usan Tokio.
- Se agregó un buffer en memoria para entornos donde no se puede escribir a disco.
- También se incorporaron integración con Metrique, eventos de networking en Linux y mejoras importantes del viewer y las APIs públicas.

## Datos curiosos opcionales

- Dial9 encontró un problema dentro del propio Dial9: una implementación de backtraces introducía un lock global y elevaba muchísimo el overhead.
- Otra investigación encontró una espera dentro del kernel al abrir grandes cantidades de conexiones simultáneas.
- El formato de traza se describe a sí mismo, lo que permite agregar nuevos tipos de eventos sin diseñar un formato nuevo para cada uno.
- El README distingue dos usos: las métricas sirven para detectar que algo anda mal; Dial9 ayuda a investigar qué ocurrió.

## Precauciones

- No encontré una explicación documentada del nombre “Dial9”.
- Evitar decir “zero overhead”: el costo depende de las fuentes habilitadas y de la carga.
- El ejemplo de código del artículo de Tokio usa Dial9 0.2. Para código actual, usar [`configuracion.md`](configuracion.md).
