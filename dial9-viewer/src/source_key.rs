use dial9_core::source_key::{SourceKeyLayout, parse_source_key};

/// Semantic fields used by both scope filtering and persisted Parquet rows.
/// Returns `None` when a required field is missing or malformed.
pub(crate) fn scope_fields(key: &str) -> Option<(String, String, String)> {
    let parsed = parse_source_key(key);
    if parsed.layout != SourceKeyLayout::Unknown {
        return Some((parsed.date?, parsed.service?, parsed.instance?));
    }

    // Preserve best-effort support for custom, non-date layouts.
    let path = key
        .strip_prefix("s3://")
        .and_then(|rest| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or(key);
    let parts: Vec<&str> = path.split('/').collect();
    Some((
        parts.first()?.to_string(),
        parts.get(2)?.to_string(),
        parts.get(3)?.to_string(),
    ))
}
