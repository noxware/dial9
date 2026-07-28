//! Rust SDK for capability-isolated dial9 viewer extensions.
//!
//! An extension receives allocation-free event views from a streaming D9TF
//! decoder and emits typed columnar batches. A static manifest describes which
//! semantic viewer components consume those tables.

mod event;
mod manifest;
mod output;
mod runtime;

pub use event::{Event, Field, StackFrames, Value};
pub use output::{Column, OutputError, OutputSink, TableId};
pub use runtime::{Extension, ExtensionError};

/// Include a JSON manifest and generate typed output table bindings.
///
/// The path is relative to the invoking crate's `CARGO_MANIFEST_DIR`. Invoke
/// this once at crate root. Generated bindings live under `tables`, with
/// `Row`, `Batch`, and `ID` inside a module named after each manifest table.
#[macro_export]
macro_rules! include_manifest {
    ($path:literal) => {
        $crate::__private::include_manifest_codegen!($crate, $path);
    };
}

/// Place one compact static JSON manifest in the Wasm custom section consumed
/// by the viewer.
///
/// Invoke this once at crate root.
#[macro_export]
macro_rules! manifest {
    ($json:expr) => {
        const _: () = {
            const SOURCE: &str = $json;
            const LEN: usize = $crate::__private::compact_json_len(SOURCE.as_bytes());
            #[used]
            #[cfg_attr(target_arch = "wasm32", unsafe(link_section = "dial9.viewer.manifest"))]
            static DIAL9_VIEWER_MANIFEST: [u8; LEN] =
                $crate::__private::compact_json::<LEN>(SOURCE.as_bytes());
        };
    };
}

/// Export an [`Extension`] implementation through the versioned dial9 ABI.
#[macro_export]
macro_rules! export_extension {
    ($extension:ty) => {
        #[cfg(target_arch = "wasm32")]
        static DIAL9_EXTENSION: $crate::__private::GlobalRuntime<$extension> =
            $crate::__private::GlobalRuntime::new();

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_abi_version() -> u32 {
            $crate::__private::ABI_VERSION
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_input_alloc(len: u32) -> u32 {
            DIAL9_EXTENSION.input_alloc(len)
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_push(len: u32) -> i32 {
            DIAL9_EXTENSION.push(len)
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_finish() -> i32 {
            DIAL9_EXTENSION.finish()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_next() -> u32 {
            DIAL9_EXTENSION.output_next()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_descriptor_len() -> u32 {
            DIAL9_EXTENSION.output_descriptor_len()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_ack() -> i32 {
            DIAL9_EXTENSION.output_ack()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_error_ptr() -> u32 {
            DIAL9_EXTENSION.error_ptr()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_error_len() -> u32 {
            DIAL9_EXTENSION.error_len()
        }
    };
}

#[doc(hidden)]
pub mod __private {
    pub use crate::manifest::{compact_json, compact_json_len};
    pub use crate::runtime::ABI_VERSION;
    #[cfg(target_arch = "wasm32")]
    pub use crate::runtime::GlobalRuntime;
    pub use dial9_viewer_extension_macros::include_manifest as include_manifest_codegen;
}

#[cfg(test)]
mod include_manifest_tests {
    use super::{Column, OutputSink, TableId};
    use std::collections::VecDeque;

    include_manifest!("tests/fixtures/include-manifest.json");

    #[test]
    fn generated_batch_encodes_nullability_and_utf8() {
        let mut batch = tables::samples::Batch::new();
        batch
            .push(tables::samples::Row {
                timestamp_ns: 10,
                value: Some(1.5),
                label: "🔥",
                note: None,
                r#type: 1,
            })
            .unwrap();
        batch
            .push(tables::samples::Row {
                timestamp_ns: 20,
                value: None,
                label: "ok",
                note: Some("x"),
                r#type: 2,
            })
            .unwrap();

        let mut emitted = VecDeque::new();
        batch.emit(&mut OutputSink::new(&mut emitted)).unwrap();
        let batch = emitted.front().unwrap();
        assert_eq!(batch.table, TableId::new(0));
        assert_eq!(batch.rows, 2);
        assert_eq!(batch.columns.len(), 5);
        assert!(matches!(
            &batch.columns[0],
            Column::U64 {
                values,
                validity: None,
            } if values == &[10, 20]
        ));
        assert!(matches!(
            &batch.columns[1],
            Column::F64 {
                values,
                validity: Some(validity),
            } if values == &[1.5, 0.0] && validity == &[0b0000_0001]
        ));
        assert!(matches!(
            &batch.columns[2],
            Column::Utf8 {
                offsets,
                data,
                validity: None,
            } if offsets == &[0, 4, 6] && data == "🔥ok".as_bytes()
        ));
        assert!(matches!(
            &batch.columns[3],
            Column::Utf8 {
                offsets,
                data,
                validity: Some(validity),
            } if offsets == &[0, 0, 1]
                && data == b"x"
                && validity == &[0b0000_0010]
        ));
    }
}
