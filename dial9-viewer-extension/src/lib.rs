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

/// Place one compact static JSON manifest in the Wasm custom section consumed
/// by the viewer.
///
/// Invoke this once at crate root.
#[macro_export]
macro_rules! manifest {
    ($json:literal) => {
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
}
