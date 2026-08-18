use dial9_core::segment_object_key::{SegmentObjectKeyLayout, parse_segment_object_key};

/// Semantic fields used by both scope filtering and persisted Parquet rows.
/// Returns `None` when a required field is missing or malformed.
pub(crate) fn scope_fields(key: &str) -> Option<(String, String, String)> {
    let parsed = parse_segment_object_key(key);
    if parsed.layout != SegmentObjectKeyLayout::Unknown {
        return Some((parsed.date?, parsed.service?, parsed.instance?));
    }

    // Preserve best-effort support for custom, non-date layouts.
    let path = key
        .strip_prefix("s3://")
        .and_then(|rest| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or(key);
    let parts: Vec<&str> = path.split('/').collect();
    if parts
        .iter()
        .any(|part| part.starts_with("date=") || is_date(part))
    {
        return None;
    }
    Some((
        parts.first()?.to_string(),
        parts.get(2)?.to_string(),
        parts.get(3)?.to_string(),
    ))
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_structured_keys_do_not_use_the_custom_fallback() {
        for key in [
            "traces/date=2026-08-14/time=1937/service=bad%2/instance=host/1-0.bin.gz",
            "traces/2026-08-14/1937/service/host/boot/extra/1-0.bin.gz",
        ] {
            assert_eq!(scope_fields(key), None, "{key}");
        }

        assert_eq!(
            scope_fields("custom/prefix/service/host/1-0.bin.gz"),
            Some(("custom".into(), "service".into(), "host".into()))
        );
    }

    #[test]
    fn hive_scope_fields_are_named_and_boot_is_optional() {
        assert_eq!(
            scope_fields(
                "traces/date=2026-08-14/region=uy/instance=host%2Fone/service=svc/time=1937/1-0.bin.gz"
            ),
            Some(("2026-08-14".into(), "svc".into(), "host/one".into()))
        );
    }
}
