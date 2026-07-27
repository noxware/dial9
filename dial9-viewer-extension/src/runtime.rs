use crate::event::Event;
use crate::output::OutputSink;
#[cfg(any(test, target_arch = "wasm32"))]
use dial9_trace_format::decoder::StreamingDecoder;
#[cfg(target_arch = "wasm32")]
use std::cell::UnsafeCell;
use std::fmt;

#[cfg(target_arch = "wasm32")]
pub const ABI_VERSION: u32 = 1;

pub type Result<T> = std::result::Result<T, ExtensionError>;

/// Error returned by extension computation or output validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionError {
    message: String,
}

impl ExtensionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ExtensionError {}

/// Stateful computation hosted by the viewer.
pub trait Extension: Default + 'static {
    fn on_start(&mut self, _output: &mut OutputSink) -> Result<()> {
        Ok(())
    }

    fn on_event(&mut self, _event: Event<'_, '_>, _output: &mut OutputSink) -> Result<()> {
        Ok(())
    }

    fn finish(self, _output: &mut OutputSink) -> Result<()> {
        Ok(())
    }
}

#[cfg(any(test, target_arch = "wasm32"))]
struct Runtime<E> {
    decoder: StreamingDecoder,
    extension: Option<E>,
    output: OutputSink,
    #[cfg(target_arch = "wasm32")]
    input: Vec<u8>,
    #[cfg(target_arch = "wasm32")]
    descriptor: Vec<u32>,
    error: Vec<u8>,
    started: bool,
    #[cfg(target_arch = "wasm32")]
    output_staged: bool,
    failed: bool,
    finished: bool,
}

#[cfg(any(test, target_arch = "wasm32"))]
impl<E: Extension> Runtime<E> {
    fn new() -> Self {
        Self {
            decoder: StreamingDecoder::new(),
            extension: Some(E::default()),
            output: OutputSink::new(),
            #[cfg(target_arch = "wasm32")]
            input: Vec::new(),
            #[cfg(target_arch = "wasm32")]
            descriptor: Vec::new(),
            error: Vec::new(),
            started: false,
            #[cfg(target_arch = "wasm32")]
            output_staged: false,
            failed: false,
            finished: false,
        }
    }

    fn start(&mut self) -> Result<()> {
        if self.started {
            return Ok(());
        }
        self.extension
            .as_mut()
            .expect("extension exists until finish")
            .on_start(&mut self.output)?;
        self.started = true;
        Ok(())
    }

    fn push_chunk(&mut self, chunk: &[u8]) -> i32 {
        if self.failed || self.finished {
            return 1;
        }
        if let Err(error) = self.start() {
            self.fail(error.to_string());
            return 1;
        }

        let Self {
            decoder,
            extension,
            output,
            ..
        } = self;
        let extension = extension.as_mut().expect("extension exists until finish");
        match decoder.push(chunk, |raw| extension.on_event(Event::new(raw), output)) {
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
        if let Err(error) = self.start() {
            self.fail(error.to_string());
            return 1;
        }
        if let Err(error) = self.decoder.finish() {
            self.fail(error.to_string());
            return 1;
        }

        let extension = self
            .extension
            .take()
            .expect("extension exists until finish");
        match extension.finish(&mut self.output) {
            Ok(()) => {
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
        self.output.clear();
        #[cfg(target_arch = "wasm32")]
        {
            self.descriptor.clear();
            self.output_staged = false;
        }
        self.failed = true;
    }

    #[cfg(target_arch = "wasm32")]
    fn input_reserve(&mut self, len: u32) -> u32 {
        if self.failed || self.finished {
            return 0;
        }
        self.input.resize(len as usize, 0);
        if self.input.is_empty() {
            0
        } else {
            self.input.as_mut_ptr() as usize as u32
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn push(&mut self, len: u32) -> i32 {
        let len = len as usize;
        if len > self.input.len() {
            self.fail("dial9_push length exceeds the reserved input");
            return 1;
        }
        let input = std::mem::take(&mut self.input);
        let status = self.push_chunk(&input[..len]);
        self.input = input;
        status
    }

    #[cfg(target_arch = "wasm32")]
    fn output_next(&mut self) -> i32 {
        if self.failed {
            return -1;
        }
        if self.output_staged {
            return 1;
        }
        let Some(batch) = self.output.front() else {
            return 0;
        };
        self.descriptor = batch.descriptor();
        self.output_staged = true;
        1
    }

    #[cfg(target_arch = "wasm32")]
    fn output_ack(&mut self) -> i32 {
        if !self.output_staged || self.output.pop_front().is_none() {
            self.fail("dial9_output_ack called without a staged output");
            return 1;
        }
        self.descriptor.clear();
        self.output_staged = false;
        0
    }

    #[cfg(target_arch = "wasm32")]
    fn output_descriptor_ptr(&self) -> u32 {
        if self.descriptor.is_empty() {
            0
        } else {
            self.descriptor.as_ptr() as usize as u32
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn output_descriptor_len(&self) -> u32 {
        (std::mem::size_of_val(self.descriptor.as_slice())) as u32
    }

    #[cfg(target_arch = "wasm32")]
    fn error_ptr(&self) -> u32 {
        if self.error.is_empty() {
            0
        } else {
            self.error.as_ptr() as usize as u32
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn error_len(&self) -> u32 {
        self.error.len() as u32
    }
}

/// Single-threaded global runtime used by [`crate::export_extension!`].
///
/// The module has no imports, so guest code cannot re-enter these exports. The
/// host invokes one export at a time from one dedicated Worker.
#[cfg(target_arch = "wasm32")]
pub struct GlobalRuntime<E>(UnsafeCell<Option<Runtime<E>>>);

#[cfg(target_arch = "wasm32")]
unsafe impl<E> Sync for GlobalRuntime<E> {}

#[cfg(target_arch = "wasm32")]
impl<E: Extension> GlobalRuntime<E> {
    pub const fn new() -> Self {
        Self(UnsafeCell::new(None))
    }

    fn runtime(&self) -> &mut Runtime<E> {
        // SAFETY: core WebAssembly is single-threaded here, the module imports
        // no re-entrant host functions, and the Worker calls exports serially.
        let slot = unsafe { &mut *self.0.get() };
        slot.get_or_insert_with(Runtime::new)
    }

    pub fn input_reserve(&self, len: u32) -> u32 {
        self.runtime().input_reserve(len)
    }

    pub fn push(&self, len: u32) -> i32 {
        self.runtime().push(len)
    }

    pub fn finish(&self) -> i32 {
        self.runtime().finish()
    }

    pub fn output_next(&self) -> i32 {
        self.runtime().output_next()
    }

    pub fn output_descriptor_ptr(&self) -> u32 {
        self.runtime().output_descriptor_ptr()
    }

    pub fn output_descriptor_len(&self) -> u32 {
        self.runtime().output_descriptor_len()
    }

    pub fn output_ack(&self) -> i32 {
        self.runtime().output_ack()
    }

    pub fn error_ptr(&self) -> u32 {
        self.runtime().error_ptr()
    }

    pub fn error_len(&self) -> u32 {
        self.runtime().error_len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Column, TableId};
    use dial9_trace_format::encoder::Encoder;
    use dial9_trace_format::schema::FieldDef;
    use dial9_trace_format::types::{FieldType, FieldValue};

    #[derive(Default)]
    struct CountEvents {
        count: u64,
    }

    impl Extension for CountEvents {
        fn on_start(&mut self, output: &mut OutputSink) -> Result<()> {
            output.emit(
                TableId::new(0),
                vec![Column::U8 {
                    values: vec![7],
                    validity: None,
                }],
            )
        }

        fn on_event(&mut self, event: Event<'_, '_>, _output: &mut OutputSink) -> Result<()> {
            assert_eq!(event.name(), "Ev");
            self.count += 1;
            Ok(())
        }

        fn finish(self, output: &mut OutputSink) -> Result<()> {
            output.emit(
                TableId::new(1),
                vec![Column::U64 {
                    values: vec![self.count],
                    validity: None,
                }],
            )
        }
    }

    fn trace() -> Vec<u8> {
        let mut encoder = Encoder::new();
        let schema = encoder
            .register_schema("Ev", vec![FieldDef::new("value", FieldType::Varint)])
            .unwrap();
        for value in 0..3 {
            encoder
                .write_event(
                    &schema,
                    &[FieldValue::Varint(value), FieldValue::Varint(value)],
                )
                .unwrap();
        }
        encoder.finish()
    }

    #[test]
    fn lifecycle_streams_events_and_keeps_emitted_batches() {
        let data = trace();
        let mut runtime = Runtime::<CountEvents>::new();
        for chunk in data.chunks(2) {
            assert_eq!(runtime.push_chunk(chunk), 0);
        }
        assert_eq!(runtime.finish(), 0);
        assert_eq!(runtime.output.len(), 2);
        assert!(runtime.finished);
    }

    #[derive(Default)]
    struct Fails;

    impl Extension for Fails {
        fn on_event(&mut self, _event: Event<'_, '_>, output: &mut OutputSink) -> Result<()> {
            output.emit(
                TableId::new(0),
                vec![Column::U8 {
                    values: vec![1],
                    validity: None,
                }],
            )?;
            Err(ExtensionError::new("extension failed"))
        }
    }

    #[test]
    fn failure_discards_partial_output() {
        let mut runtime = Runtime::<Fails>::new();
        assert_eq!(runtime.push_chunk(&trace()), 1);
        assert_eq!(runtime.output.len(), 0);
        assert_eq!(runtime.error, b"extension failed");
    }
}
