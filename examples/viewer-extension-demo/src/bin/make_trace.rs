use dial9_trace_format::{EmbeddedFile, TraceEvent, encoder::Encoder};
use std::env;
use std::fs;
use std::io;

#[derive(TraceEvent)]
#[traceevent(wire_slot)]
struct SegmentMetadataEvent {
    #[traceevent(timestamp)]
    timestamp_ns: u64,
    entries: Vec<(String, String)>,
}

#[derive(TraceEvent)]
#[traceevent(wire_slot)]
struct ProcessResourceUsageEvent {
    #[traceevent(timestamp)]
    timestamp_ns: u64,
    #[traceevent(unit = "ns")]
    user_cpu_ns: u64,
    #[traceevent(unit = "ns")]
    system_cpu_ns: u64,
    #[traceevent(unit = "bytes")]
    max_rss_bytes: u64,
    minor_faults: u64,
    major_faults: u64,
    block_input_ops: u64,
    block_output_ops: u64,
    voluntary_context_switches: u64,
    involuntary_context_switches: u64,
}

fn usage_sample(
    sample: u64,
    user_cpu_ns: &mut u64,
    system_cpu_ns: &mut u64,
    voluntary: &mut u64,
    involuntary: &mut u64,
) -> ProcessResourceUsageEvent {
    *user_cpu_ns += 80_000_000 + (sample % 8) * 10_000_000;
    *system_cpu_ns += 20_000_000 + (sample % 5) * 5_000_000;
    *voluntary += 3 + sample % 7;
    *involuntary += 1 + sample % 3;

    if sample == 30 {
        *user_cpu_ns /= 3;
    }
    if sample == 50 {
        *voluntary = 2;
    }

    ProcessResourceUsageEvent {
        timestamp_ns: 1_000_000_000 + sample * 250_000_000,
        user_cpu_ns: *user_cpu_ns,
        system_cpu_ns: *system_cpu_ns,
        max_rss_bytes: 64 * 1024 * 1024,
        minor_faults: sample * 2,
        major_faults: 0,
        block_input_ops: 0,
        block_output_ops: 0,
        voluntary_context_switches: *voluntary,
        involuntary_context_switches: *involuntary,
    }
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn main() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let wasm_path = args
        .next()
        .ok_or_else(|| invalid_input("usage: make_trace <extension.wasm> <trace.bin> [samples]"))?;
    let trace_path = args
        .next()
        .ok_or_else(|| invalid_input("usage: make_trace <extension.wasm> <trace.bin> [samples]"))?;
    let samples = args
        .next()
        .map(|value| {
            value
                .to_str()
                .ok_or_else(|| invalid_input("samples must be UTF-8"))?
                .parse::<u64>()
                .map_err(|error| invalid_input(format!("invalid sample count: {error}")))
        })
        .transpose()?
        .unwrap_or(80);
    if args.next().is_some() {
        return Err(invalid_input(
            "usage: make_trace <extension.wasm> <trace.bin> [samples]",
        ));
    }

    let wasm = fs::read(wasm_path)?;
    let extension = EmbeddedFile::owned("viewer-extension-demo.wasm", wasm)
        .map_err(|error| invalid_input(error.to_string()))?;
    let mut encoder = Encoder::new();
    encoder.write_embedded_file(&extension)?;
    encoder.write(&SegmentMetadataEvent {
        timestamp_ns: 1_000_000_000,
        entries: vec![("process.available_parallelism".into(), "11".into())],
    })?;

    let mut user_cpu_ns = 0;
    let mut system_cpu_ns = 0;
    let mut voluntary = 0;
    let mut involuntary = 0;
    for sample in 0..samples {
        encoder.write(&usage_sample(
            sample,
            &mut user_cpu_ns,
            &mut system_cpu_ns,
            &mut voluntary,
            &mut involuntary,
        ))?;
    }
    fs::write(trace_path, encoder.finish())
}
