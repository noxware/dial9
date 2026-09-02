## dial9

---

## ¿Qué es?

Dial9 es una herramienta de telemetría y profiling para Rust que captura, con bajo overhead, eventos de la aplicación, el runtime y el sistema operativo, y los correlaciona en una línea de tiempo para analizarlos después.

---

## Lore

- Un servicio con un problema de performance que sólo aparecía a escala de producción.
- Había métricas agregadas, pero estas mostraban el síntoma, no la causa.
- Necesitaba reconstruir detalladamente qué ocurría, sin degradar más prod.

Notes:
- Russell, creador.
- Servicio conectaba miles de hosts concurrentemente.
- Primera grabación mostró demoras de más de 10 ms provenientes del sistema operativo.


---

## Dial9 originalmente

Nació como `dial9-tokio-telemetry`:

telemetría enfocada en observar la ejecución del runtime async **Tokio**.

---

## Tokio (tl;dr)

- Rust ofrece `Future` y `async/await`, pero no incluye un runtime async.
- Tokio es el runtime más utilizado para ejecutar ese código.

Notes:
- Rust soporta concurrencia principalmente a través del **trait** (interface) `Future` y de la sintaxis `async/await`.
- Pero no incluye el componente en **runtime** que coordina y avanza estas `Future`s.
- Al crear programas **nativos** en Rust, **Tokio** es el **crate** (librería) que los devs suelen agregar para cumplir ese rol.

---

## Dial9 hoy en día (v0.5)

- Tokio
- CPU y memoria
- Sistema operativo
- Eventos propios de la aplicación

Notes:
- Actividad del runtime de Tokio.
- Samples de CPU y memoria.
- Información del sistema operativo.
- Spans, métricas y eventos propios de la aplicación.
- Se puede habilitar sólo lo necesario para cada caso.

Dial9 agrandó su scope y posibilidades, se volvió modular y es útil incluso en apps que no usan async ni Tokio para reconstruir otros detalles.

## Users

...

## Ejemplo

```rust
#[dial9::main(config = dial9::recorder_from_env)]
async fn main() {
    // ... tu codigo ...
}
```

```bash
DIAL9_ENABLED=true cargo run
```


Notes:
- Por defecto, escribe las trazas en `/tmp/dial9-traces`.
- También se puede configurar explícitamente para elegir qué recolectar y dónde almacenarlo.

## Demo

...
