# Configuración para mostrar

## Opción mínima: configuración por ambiente

`Cargo.toml`:

```toml
[dependencies]
dial9 = { version = "0.5", features = ["tokio"] }
```

Aplicación:

```rust
#[dial9::main(config = dial9::recorder_from_env)]
async fn main() {
    // la aplicación
}
```

Al ejecutar:

```sh
DIAL9_ENABLED=true \
DIAL9_TRACE_DIR=/tmp/dial9-traces \
DIAL9_MAX_DISK_USAGE_MB=100 \
cargo run
```

**Qué decir:** “Dial9 construye un runtime Tokio instrumentado y rota las trazas dentro de un presupuesto de disco. También puede configurarse explícitamente y escribir en memoria o subir segmentos a S3.”

## Opción explícita, por si preguntan

```rust
use dial9::{AttachedRuntime, Dial9HandleTokioExt, DiskBuffer, TokioAttachOptions};

fn dial9_config() -> std::io::Result<AttachedRuntime> {
    let buffer = DiskBuffer::builder()
        .base_path("/tmp/dial9-traces")
        .max_total_size(100 * 1024 * 1024)
        .build();

    let recorder = dial9::recorder_or_disabled(buffer).build();

    let mut tokio = tokio::runtime::Builder::new_multi_thread();
    tokio.enable_all();

    let runtime = recorder.handle().attach_tokio_runtime(
        tokio,
        TokioAttachOptions::default(),
    )?;

    Ok((recorder, runtime))
}

#[dial9::main(config = dial9_config)]
async fn main() {
    // la aplicación
}
```

Este segundo ejemplo hace visible la idea de 0.5: primero se crea el buffer y el recorder; Tokio se adjunta después como una fuente de eventos.
