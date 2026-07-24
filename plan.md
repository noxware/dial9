# Extensiones WASM y vistas componibles

## Resumen

El viewer ejecutará cómputo Rust no confiable como Core WebAssembly sin imports ni WASI. El modelo sigue la separación de Perfetto entre datasets tipados y renderers reutilizables, sin exponer Canvas a terceros. [Perfetto UI plugins](https://perfetto.dev/docs/contributing/ui-plugins)

```text
D9TF descomprimido ─┬─→ parser normal del viewer
                    └─→ Worker por WASM → record batches columnares
                                           ↓
                               store scopeado por instancia
                                           ↓
                           paneles de componentes stackeables
```

- Legacy primero, con core y componentes en TypeScript mediante una entrada Vite.
- WASM se ejecuta una vez por trace; viewport, legends y tooltips consultan el output materializado.
- Sin callbacks reactivos WASM en v1.
- CPU exacto y dinosaurio son las validaciones visibles; los paneles originales permanecen.

## Contratos públicos

### Embedded files en D9TF

- Agregar frame genérico `EmbeddedFile` (`0x07`): `name_len:u16`, `data_len:u32`, nombre UTF-8 y bytes.
- Los frames forman un preámbulo contiguo inmediatamente después del header.
- `SegmentWriter` difiere `ClockSyncEvent` hasta escribir ese preámbulo y lo repite en cada segmento físico para que cualquiera pueda abrirse aisladamente.
- API Rust:
  - `EmbeddedFile::borrowed(name, &'static [u8])`
  - `EmbeddedFile::owned(name, Vec<u8>)`
  - `RecorderBuilder::embedded_file(file)`
- El nombre es una etiqueta opaca, no un ID global; cada frame representa una instancia independiente.
- El viewer v1 autoejecuta solamente archivos terminados en `.wasm` presentes en el primer segmento de la carga lógica. Attachments posteriores se ignoran.
- El documento de diseño registrará las alternativas descartadas: upgrade con replay, implementación por segmento, primer ID visto y activación manual futura.

### SDK y ABI WASM

Nuevo crate `dial9-viewer-extension`:

```rust
pub trait Extension: Default {
    fn on_start(&mut self, output: &mut OutputSink) -> Result<()> {
        Ok(())
    }

    fn on_event(
        &mut self,
        event: Event<'_>,
        output: &mut OutputSink,
    ) -> Result<()> {
        Ok(())
    }

    fn finish(
        self,
        output: &mut OutputSink,
    ) -> Result<ViewManifest>;
}
```

- `Event` y `Value` son vistas allocation-free sobre el decoder streaming D9TF y exponen nombre, timestamp, fields, units, listas, mapas, strings, bytes y stacks.
- `OutputSink::emit(RecordBatch)` permite emitir durante el parse o acumular y emitir en `finish()`.
- El primer batch de una tabla fija su schema; batches posteriores deben coincidir.
- ABI numérico versionado: reserva/push/resume de input, finish, next/ack de output, descriptor/data pointers y error buffer.
- El runtime puede pausar un `push` cuando haya output listo, dejar que el host lo drene y luego continuar.
- El módulo exporta memoria y funciones; no importa ninguna capacidad del host. `wasm32-unknown-unknown` será el target soportado. [Rust target documentation](https://doc.rust-lang.org/stable/rustc/platform-support/wasm32-unknown-unknown.html)

### Output y manifest

- Stream binario liviano propio, no Arrow ni un `D9VO` monolítico.
- Tablas scopeadas automáticamente por token de instancia.
- Columnas iniciales: `f64`, `i64`, `u64`, `u32`, `u8` y UTF-8; validity bitmap y unit opcionales.
- El worker copia una columna desde linear memory y transfiere su `ArrayBuffer`; el guest libera el batch antes de continuar.
- El viewer conserva columnas chunked. UTF-8 permanece como offsets + bytes y se decodifica bajo demanda.
- `finish()` entrega el manifest JSON; los paneles se publican atómicamente sólo después de validar toda la extensión.

Manifest v1:

- Paneles con título, altura, eje X temporal o lineal y escalas Y nombradas.
- Cada componente lleva `kind`, `version`, `id`, tabla y mappings de columnas.
- Componentes iniciales:
  - `background`
  - `interval-area`
  - `interval-line`
  - `line`
  - `step-line`
  - `polyline`
  - `horizontal-rule`
  - `tooltip`
  - `legend`
- Tooltip y legend son componentes presenter: consumen los mismos rows/hits, aunque rendericen DOM.
- Legend soporta texto estático, sampling al cursor y reducers visibles `min`, `max`, `sum`, `count`, `mean` y media ponderada por intersección temporal.
- Formatters incluyen números, enteros, durations, units y porcentaje respecto de un scalar.
- Escalas soportan dominio visible o fijo, cero y scalars adicionales; esto cubre capacity y múltiples ejes.
- Tipos/versiones desconocidos deshabilitan sólo el panel afectado.

## Implementación

- Reutilizar selectivamente de `p8` el decoder incremental y las vistas `Event`/`Value`; reemplazar su worker único, policy parser propio y output monolítico.
- Usar el CPU actual de `main` como verdad de paridad y los puntos del dinosaurio de `p5` como fixture visual.
- Un Worker dedicado por módulo:
  - `WebAssembly.Module.imports()` debe estar vacío.
  - Instanciación con `{}` y sin glue de `wasm-bindgen`.
  - Pointer/length, UTF-8, batches, schemas y referencias del manifest validados antes de llegar al main thread.
  - Trap, timeout o output inválido elimina sólo esa extensión y sus batches.
- Defaults internos:
  - chunks de 256 KiB y hasta dos en vuelo por worker;
  - máximo ocho `.wasm` automáticos, 4 MiB por módulo;
  - output acumulado máximo de 256 MiB por instancia;
  - 10 s por entrada normal y 60 s para `finish`;
  - SDK compilado con máximo recomendado de 128 MiB.
- Esto es aislamiento de capacidades, no garantía absoluta de disponibilidad: un módulo artesanal puede declarar otros límites de memoria y un OOM extremo continúa siendo riesgo de la pestaña. No se agregará un parser WASM custom en v1.
- Convertir `viewer.html` en entrada Vite, manteniendo sus scripts legacy, y añadir un adaptador TypeScript fino para:
  - fanout de chunks D9TF;
  - lifecycle de extensiones;
  - inserción/render de paneles;
  - viewport y tooltip compartidos;
  - llamada al runtime desde `renderAll()`.
- Un `.wasm` arrastrado crea siempre una instancia nueva:
  - sin trace queda pendiente para el próximo;
  - con trace procesa el buffer retenido;
  - se elimina al reemplazar esa carga lógica.
- Renderers indexan columnas por tiempo, dibujan sólo la ventana visible y realizan coalescing/min-max por píxel donde corresponda.
- Hit testing usa distancia y orden Z inverso; strings se insertan como texto, nunca HTML.

## Validación

- CPU extension:
  - misma selección y ordenamiento de samples;
  - mismos gaps ante timestamps inválidos o counters decrecientes;
  - intervals, deltas, cores y percentages idénticos;
  - área, borde superior, escala, gradient y capacity guide;
  - readout visible `avg/percent/max`;
  - tooltip `Window`, `CPU time`, `Cores`, `Total CPU`;
  - comparación visual lado a lado con el panel original.
- Dinosaurio:
  - fondo verde oscuro, cuerpo verde mediante `polyline`;
  - coordenadas repetidas o hacia atrás preservadas;
  - fuego dibujado con líneas reales;
  - 💩 en cola, ❤️ en cabeza y tooltip propio para flames.
- Tests adicionales:
  - line y step-line superpuestos con tooltips independientes;
  - fixture de manifest para el layout/reducers de queue depth, sin reemplazar su panel;
  - attachments partidos en cualquier byte boundary y repetidos por rotación;
  - múltiples módulos, drops antes/después del trace y aislamiento de fallos;
  - imports, traps, loops, pointers fuera de memoria, manifests maliciosos y texto HTML;
  - batches múltiples, nullability, units y UTF-8 lazy.
- Benchmark reproducible con el fixture de 250k eventos de `p8` y un trace generado grande:
  - compilación medida aparte;
  - tiempo de decode/cómputo/transferencia;
  - memoria guest y host;
  - ausencia de objetos por row y de un buffer de output completo duplicado.
- CI instala `wasm32-unknown-unknown`, compila la extensión de ejemplo y ejecuta Rust, Vitest, build Vite y Playwright.

## Diferido explícitamente

- Adaptador para el viewer nuevo.
- Callbacks WASM reactivos.
- Activación de attachments encontrados en traces posteriores.
- Hosts CLI/server-side.
- Heatmap, slices, spans y flamegraph como nuevos componentes.
- Validador estático estricto de recursos internos WASM.
