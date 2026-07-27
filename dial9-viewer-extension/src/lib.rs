//! Rust SDK for sandboxed dial9 viewer extensions.
//!
//! Extensions decode D9TF directly inside WebAssembly and emit typed columnar
//! batches consumed by reusable viewer components.

mod event;
mod manifest;
mod output;
mod runtime;

pub use event::{Event, StackFrames, Value};
pub use output::{Column, OutputSink, TableId};
pub use runtime::{Extension, ExtensionError, Result};

/// Embed the extension manifest in the `dial9.viewer.manifest` WebAssembly
/// custom section.
///
/// The argument must be a string literal. JSON whitespace outside strings is
/// removed at compile time; strings and escapes are preserved byte-for-byte.
#[macro_export]
macro_rules! manifest {
    ($json:literal $(,)?) => {
        const _: () = {
            #[cfg(target_arch = "wasm32")]
            #[used]
            #[unsafe(link_section = "dial9.viewer.manifest")]
            static DIAL9_VIEWER_MANIFEST: [u8; $crate::__private::compacted_json_len($json)] =
                $crate::__private::compact_json::<{ $crate::__private::compacted_json_len($json) }>(
                    $json,
                );
        };
    };
}

/// Export an [`Extension`] through dial9's versioned core WebAssembly ABI.
#[macro_export]
macro_rules! export_extension {
    ($extension:ty) => {
        #[cfg(target_arch = "wasm32")]
        static DIAL9_VIEWER_EXTENSION: $crate::__private::GlobalRuntime<$extension> =
            $crate::__private::GlobalRuntime::new();

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_abi_version() -> u32 {
            $crate::__private::ABI_VERSION
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_input_reserve(len: u32) -> u32 {
            DIAL9_VIEWER_EXTENSION.input_reserve(len)
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_push(len: u32) -> i32 {
            DIAL9_VIEWER_EXTENSION.push(len)
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_finish() -> i32 {
            DIAL9_VIEWER_EXTENSION.finish()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_next() -> i32 {
            DIAL9_VIEWER_EXTENSION.output_next()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_descriptor_ptr() -> u32 {
            DIAL9_VIEWER_EXTENSION.output_descriptor_ptr()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_descriptor_len() -> u32 {
            DIAL9_VIEWER_EXTENSION.output_descriptor_len()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_ack() -> i32 {
            DIAL9_VIEWER_EXTENSION.output_ack()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_error_ptr() -> u32 {
            DIAL9_VIEWER_EXTENSION.error_ptr()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_error_len() -> u32 {
            DIAL9_VIEWER_EXTENSION.error_len()
        }
    };
}

#[doc(hidden)]
pub mod __private {
    pub use crate::manifest::{compact_json, compacted_json_len};
    #[cfg(target_arch = "wasm32")]
    pub use crate::runtime::{ABI_VERSION, GlobalRuntime};
}
