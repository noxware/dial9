use crate::{Event, ViewBundle};
#[cfg(target_arch = "wasm32")]
use dial9_trace_format::decoder::StreamingDecoder;
#[cfg(target_arch = "wasm32")]
use std::cell::UnsafeCell;
use std::fmt;

#[cfg(target_arch = "wasm32")]
pub const ABI_VERSION: u32 = 1;

/// User computation hosted by the viewer. It has no ambient browser
/// capabilities; all state is ordinary Rust state owned by this value.
pub trait Extension: Default + 'static {
    fn on_event(&mut self, event: Event<'_, '_>) -> Result<(), ExtensionError>;
    fn finish(&mut self) -> Result<ViewBundle, ExtensionError>;
}

#[derive(Debug, Clone)]
pub struct ExtensionError(String);

impl ExtensionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ExtensionError {}

#[cfg(target_arch = "wasm32")]
struct Runtime<E> {
    decoder: StreamingDecoder,
    extension: E,
    input: Vec<u8>,
    output: Vec<u8>,
    error: Vec<u8>,
    failed: bool,
    finished: bool,
}

#[cfg(target_arch = "wasm32")]
impl<E: Extension> Runtime<E> {
    fn new() -> Self {
        Self {
            decoder: StreamingDecoder::new(),
            extension: E::default(),
            input: Vec::new(),
            output: Vec::new(),
            error: Vec::new(),
            failed: false,
            finished: false,
        }
    }

    fn input_alloc(&mut self, len: u32) -> u32 {
        if self.finished {
            self.fail("input requested after dial9_finish");
            return 0;
        }
        let Ok(len) = usize::try_from(len) else {
            self.fail("input length does not fit usize");
            return 0;
        };
        self.input.resize(len, 0);
        self.input.as_mut_ptr() as usize as u32
    }

    fn push(&mut self, len: u32) -> i32 {
        if self.failed || self.finished {
            return 1;
        }
        let len = len as usize;
        if len > self.input.len() {
            self.fail("dial9_push length exceeds the allocated input");
            return 1;
        }
        let Self {
            decoder,
            extension,
            input,
            ..
        } = self;
        let result = decoder.push(&input[..len], |event| extension.on_event(Event::new(event)));
        match result {
            Ok(()) => 0,
            Err(error) => {
                self.fail(error.to_string());
                1
            }
        }
    }

    fn finish(&mut self) -> i32 {
        if self.failed || self.finished {
            return 1;
        }
        if let Err(error) = self.decoder.finish() {
            self.fail(error.to_string());
            return 1;
        }
        match self.extension.finish().and_then(|bundle| {
            bundle
                .encode()
                .map_err(|e| ExtensionError::new(e.to_string()))
        }) {
            Ok(output) => {
                self.output = output;
                self.finished = true;
                0
            }
            Err(error) => {
                self.fail(error.to_string());
                1
            }
        }
    }

    fn fail(&mut self, message: impl Into<String>) {
        self.error = message.into().into_bytes();
        self.failed = true;
    }
}

/// Single-threaded Wasm global. The host ABI is non-reentrant and invokes one
/// export at a time; WebAssembly threads and shared memory are rejected before
/// instantiation.
#[cfg(target_arch = "wasm32")]
pub struct GlobalRuntime<E>(UnsafeCell<Option<Runtime<E>>>);

// SAFETY: the viewer rejects shared memory/threads and calls the ABI
// sequentially. `UnsafeCell` is used only because Rust statics require Sync.
#[cfg(target_arch = "wasm32")]
unsafe impl<E> Sync for GlobalRuntime<E> {}

#[cfg(target_arch = "wasm32")]
impl<E: Extension> GlobalRuntime<E> {
    pub const fn new() -> Self {
        Self(UnsafeCell::new(None))
    }

    fn runtime(&self) -> &mut Runtime<E> {
        // SAFETY: see the type-level invariant above. No reference escapes an
        // ABI call, and the host never invokes an export reentrantly.
        let slot = unsafe { &mut *self.0.get() };
        slot.get_or_insert_with(Runtime::new)
    }

    pub fn input_alloc(&self, len: u32) -> u32 {
        self.runtime().input_alloc(len)
    }

    pub fn push(&self, len: u32) -> i32 {
        self.runtime().push(len)
    }

    pub fn finish(&self) -> i32 {
        self.runtime().finish()
    }

    pub fn output_ptr(&self) -> u32 {
        self.runtime().output.as_ptr() as usize as u32
    }

    pub fn output_len(&self) -> u32 {
        self.runtime().output.len().try_into().unwrap_or(u32::MAX)
    }

    pub fn error_ptr(&self) -> u32 {
        self.runtime().error.as_ptr() as usize as u32
    }

    pub fn error_len(&self) -> u32 {
        self.runtime().error.len().try_into().unwrap_or(u32::MAX)
    }
}
