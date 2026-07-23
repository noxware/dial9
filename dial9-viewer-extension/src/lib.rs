//! Rust SDK for sandboxed, trace-bundled dial9 viewer extensions.
//!
//! Extensions receive the raw trace as a chunk stream, decode events inside
//! WebAssembly, and return columnar tables plus stackable panel recipes.

mod event;
mod output;
mod runtime;

pub use event::{Event, StackFrames, Value};
pub use output::{
    Component, DisplayField, LegendAtCursor, LegendPosition, LegendStaticItem,
    MAX_ENCODED_OUTPUT_BYTES, OutputError, Panel, Sampling, Scale, Table, TooltipStrategy,
    ViewBundle, XAxis,
};
pub use runtime::{Extension, ExtensionError};

/// Export an [`Extension`] implementation through dial9's fixed WebAssembly ABI.
///
/// The module must be built with bounded WebAssembly memory. The viewer
/// validates the module and its imports before instantiation.
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
        pub extern "C" fn dial9_output_ptr() -> u32 {
            DIAL9_EXTENSION.output_ptr()
        }

        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn dial9_output_len() -> u32 {
            DIAL9_EXTENSION.output_len()
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
    #[cfg(target_arch = "wasm32")]
    pub use crate::runtime::{ABI_VERSION, GlobalRuntime};
}
