use dial9_perf_self_profile::ProcessResourceUsageEvent;
use dial9_trace_format::encoder::Encoder;
use std::env;
use std::fs;
use std::io;

fn main() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let wasm_path = args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: make_trace <extension.wasm> <trace.bin> [samples]",
        )
    })?;
    let trace_path = args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: make_trace <extension.wasm> <trace.bin> [samples]",
        )
    })?;
    let samples = args
        .next()
        .map(|value| {
            value
                .to_str()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "samples must be UTF-8")
                })?
                .parse::<u64>()
                .map_err(|error| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("invalid sample count: {error}"),
                    )
                })
        })
        .transpose()?
        .unwrap_or(80);
    if args.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: make_trace <extension.wasm> <trace.bin> [samples]",
        ));
    }

    let wasm = fs::read(wasm_path)?;
    let mut encoder = Encoder::new();
    encoder.write_viewer_extension("demo", &wasm)?;
    let mut user_cpu_ns = 0;
    let mut system_cpu_ns = 0;
    let mut voluntary = 0;
    let mut involuntary = 0;
    for sample in 0..samples {
        user_cpu_ns += 80_000_000 + (sample % 8) * 10_000_000;
        system_cpu_ns += 20_000_000 + (sample % 5) * 5_000_000;
        voluntary += 3 + sample % 7;
        involuntary += 1 + sample % 3;
        encoder.write(&ProcessResourceUsageEvent {
            timestamp_ns: 1_000_000_000 + sample * 250_000_000,
            user_cpu_ns,
            system_cpu_ns,
            max_rss_bytes: 64 * 1024 * 1024,
            minor_faults: sample * 2,
            major_faults: 0,
            block_input_ops: 0,
            block_output_ops: 0,
            voluntary_context_switches: voluntary,
            involuntary_context_switches: involuntary,
        })?;
    }
    fs::write(trace_path, encoder.finish())
}
