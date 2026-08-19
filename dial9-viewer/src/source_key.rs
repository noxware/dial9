use crate::segment_object_key::{SegmentObjectKeyLayout, parse_segment_object_key};

/// Semantic fields used by both scope filtering and persisted Parquet rows.
/// Hive keys fail closed when a required field is missing or malformed;
/// historical and custom positional keys retain the viewer's best-effort fallback.
pub(crate) fn scope_fields(key: &str) -> Option<(String, String, String)> {
    scope_fields_inner(key, true)
}

/// Scope fields available to date-partitioned listing and discovery.
pub(crate) fn dated_scope_fields(key: &str) -> Option<(String, String, String)> {
    scope_fields_inner(key, false)
}

fn scope_fields_inner(key: &str, allow_custom_fallback: bool) -> Option<(String, String, String)> {
    let parsed = parse_segment_object_key(key);
    if parsed.layout != SegmentObjectKeyLayout::Unknown {
        return Some((parsed.date?, parsed.service?, parsed.instance?));
    }

    let path = key
        .strip_prefix("s3://")
        .and_then(|rest| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or(key);
    let parts: Vec<&str> = path.split('/').collect();
    if let Some(anchor) = parts
        .windows(2)
        .rposition(|pair| is_date(pair[0]) && is_time(pair[1]))
    {
        return Some((
            parts[anchor].to_string(),
            parts.get(anchor + 2)?.to_string(),
            parts.get(anchor + 3)?.to_string(),
        ));
    }

    allow_custom_fallback.then(|| {
        (
            parts.first().copied().unwrap_or_default().to_string(),
            parts.get(2).copied().unwrap_or_default().to_string(),
            parts.get(3).copied().unwrap_or_default().to_string(),
        )
    })
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

fn is_time(value: &str) -> bool {
    value.len() == 4 && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_structured_keys_do_not_use_the_custom_fallback() {
        assert_eq!(
            scope_fields("traces/date=2026-08-14/time=1937/service=bad%2/instance=host/1-0.bin.gz"),
            None
        );

        assert_eq!(
            scope_fields("custom/prefix/service/host/1-0.bin.gz"),
            Some(("custom".into(), "service".into(), "host".into()))
        );
        assert_eq!(
            scope_fields("boot/trace.0.bin"),
            Some(("boot".into(), String::new(), String::new()))
        );
    }

    #[test]
    fn ambiguous_historical_keys_keep_the_positional_fallback() {
        assert_eq!(
            scope_fields("traces/2026-08-14/1937/service/us-east-1/i-0abc123/boot/1-0.bin.gz"),
            Some(("2026-08-14".into(), "service".into(), "us-east-1".into()))
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
