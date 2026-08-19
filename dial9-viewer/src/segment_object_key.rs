//! Parsing for dial9 trace-segment object keys.

pub(crate) use crate::segment_object_key_codec::{
    format_hive_segment_object_key, hive_escape, hive_unescape,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SegmentObjectKeyLayout {
    Hive,
    PositionalWithBoot,
    PositionalWithoutBoot,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedSegmentObjectKey {
    pub(crate) layout: SegmentObjectKeyLayout,
    pub(crate) date: Option<String>,
    pub(crate) time: Option<String>,
    pub(crate) service: Option<String>,
    pub(crate) instance: Option<String>,
    pub(crate) boot_id: Option<String>,
    pub(crate) filename: String,
    pub(crate) epoch_secs: Option<i64>,
    pub(crate) segment_index: Option<u32>,
}

#[derive(Default)]
struct HiveFields {
    date: Option<String>,
    time: Option<String>,
    service: Option<String>,
    instance: Option<String>,
    boot_id: Option<String>,
}

/// Parse a dial9 segment object key, including historical layouts.
///
/// Named fields are scanned from right to left, so their last occurrence wins.
pub(crate) fn parse_segment_object_key(key: &str) -> ParsedSegmentObjectKey {
    let path = strip_s3(key);
    let parts: Vec<&str> = path.split('/').collect();
    let filename = parts.last().copied().unwrap_or_default().to_string();
    let (epoch_secs, segment_index) = parse_filename(&filename)
        .map(|(epoch, index)| (Some(epoch), Some(index)))
        .unwrap_or((None, None));

    if parts.len() >= 6 {
        let start = parts.len() - 6;
        if is_date(parts[start]) && is_time(parts[start + 1]) {
            return ParsedSegmentObjectKey {
                layout: SegmentObjectKeyLayout::PositionalWithBoot,
                date: Some(parts[start].to_string()),
                time: Some(parts[start + 1].to_string()),
                service: Some(parts[start + 2].to_string()),
                instance: Some(parts[start + 3].to_string()),
                boot_id: Some(parts[start + 4].to_string()),
                filename,
                epoch_secs,
                segment_index,
            };
        }
    }

    if parts.len() >= 5 {
        let start = parts.len() - 5;
        if is_date(parts[start]) && is_time(parts[start + 1]) {
            return ParsedSegmentObjectKey {
                layout: SegmentObjectKeyLayout::PositionalWithoutBoot,
                date: Some(parts[start].to_string()),
                time: Some(parts[start + 1].to_string()),
                service: Some(parts[start + 2].to_string()),
                instance: Some(parts[start + 3].to_string()),
                boot_id: None,
                filename,
                epoch_secs,
                segment_index,
            };
        }
    }

    if let Some(fields) = parse_hive_partitions(&parts[..parts.len() - 1]) {
        return ParsedSegmentObjectKey {
            layout: SegmentObjectKeyLayout::Hive,
            date: fields.date,
            time: fields.time,
            service: fields.service,
            instance: fields.instance,
            boot_id: fields.boot_id,
            filename,
            epoch_secs,
            segment_index,
        };
    }

    ParsedSegmentObjectKey {
        layout: SegmentObjectKeyLayout::Unknown,
        date: None,
        time: None,
        service: None,
        instance: None,
        boot_id: None,
        filename,
        epoch_secs,
        segment_index,
    }
}

fn strip_s3(key: &str) -> &str {
    if let Some(rest) = key.strip_prefix("s3://") {
        rest.split_once('/').map_or(rest, |(_, path)| path)
    } else {
        key
    }
}

fn parse_hive_partitions(parts: &[&str]) -> Option<HiveFields> {
    let mut fields = HiveFields::default();
    let mut seen = [false; 5];

    for segment in parts.iter().rev() {
        let Some((name, encoded_value)) = segment.split_once('=') else {
            continue;
        };
        match name {
            "date" if !seen[0] => {
                seen[0] = true;
                fields.date = hive_unescape(encoded_value).filter(|value| is_date(value));
            }
            "time" if !seen[1] => {
                seen[1] = true;
                fields.time = hive_unescape(encoded_value).filter(|value| is_time(value));
            }
            "service" if !seen[2] => {
                seen[2] = true;
                fields.service = hive_unescape(encoded_value);
            }
            "instance" if !seen[3] => {
                seen[3] = true;
                fields.instance = hive_unescape(encoded_value);
            }
            "boot" if !seen[4] => {
                seen[4] = true;
                fields.boot_id = hive_unescape(encoded_value);
            }
            _ => {}
        }
    }

    seen.into_iter().any(|seen| seen).then_some(fields)
}

fn parse_filename(filename: &str) -> Option<(i64, u32)> {
    let stem = filename
        .strip_suffix(".bin.gz")
        .or_else(|| filename.strip_suffix(".bin"))?;
    let (epoch, index) = stem.split_once('-')?;
    if index.contains('-') {
        return None;
    }
    Some((epoch.parse().ok()?, index.parse().ok()?))
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
    fn hive_escape_uses_the_complete_ascii_table() {
        let mut input: String = (0..=31).map(char::from).collect();
        input.push_str("\u{7f}\"#%'*/:=?\\{[]^");

        let escaped = hive_escape(&input);
        let expected_controls: String = (0..=31).map(|byte| format!("%{byte:02X}")).collect();
        assert_eq!(
            escaped,
            format!("{expected_controls}%7F%22%23%25%27%2A%2F%3A%3D%3F%5C%7B%5B%5D%5E")
        );
        assert_eq!(hive_unescape(&escaped).as_deref(), Some(input.as_str()));
    }

    #[test]
    fn hive_escape_round_trips_unicode_and_reserved_characters() {
        let value = "payments/api%=é";
        assert_eq!(hive_escape(value), "payments%2Fapi%25%3Dé");
        assert_eq!(hive_unescape(&hive_escape(value)).as_deref(), Some(value));
        assert_eq!(hive_unescape("caf%C3%A9").as_deref(), Some("café"));
    }

    #[test]
    fn hive_unescape_rejects_malformed_or_non_utf8_escapes() {
        for value in ["%", "%2", "%GG", "%FF"] {
            assert_eq!(hive_unescape(value), None, "{value:?}");
        }
    }

    #[test]
    fn formats_canonical_hive_layout() {
        assert_eq!(
            format_hive_segment_object_key(
                Some("company/date=archive/%25"),
                "2026-08-14",
                "1937",
                "payments/api",
                "us-east-1/i-0abc123",
                "boot%=1",
                "1786736220-3.bin.gz",
            ),
            "company/date=archive/%25/date=2026-08-14/time=1937/service=payments%2Fapi/instance=us-east-1%2Fi-0abc123/boot=boot%25%3D1/1786736220-3.bin.gz"
        );
    }

    #[test]
    fn parses_canonical_hive_layout() {
        let parsed = parse_segment_object_key(
            "company/date=archive/%25/date=2026-08-14/time=1937/service=payments%2Fapi/instance=us-east-1%2Fi-0abc123/boot=abcd-4242/1786736220-3.bin.gz",
        );
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Hive);
        assert_eq!(parsed.date.as_deref(), Some("2026-08-14"));
        assert_eq!(parsed.time.as_deref(), Some("1937"));
        assert_eq!(parsed.service.as_deref(), Some("payments/api"));
        assert_eq!(parsed.instance.as_deref(), Some("us-east-1/i-0abc123"));
        assert_eq!(parsed.boot_id.as_deref(), Some("abcd-4242"));
        assert_eq!(parsed.epoch_secs, Some(1_786_736_220));
        assert_eq!(parsed.segment_index, Some(3));
    }

    #[test]
    fn parses_noncanonical_hive_fields_by_name_with_optional_boot() {
        let parsed = parse_segment_object_key(
            "traces/region=uy/instance=host%2Fone/service=svc/time=1937/date=2026-08-14/1786736220-3.bin.gz",
        );
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Hive);
        assert_eq!(parsed.date.as_deref(), Some("2026-08-14"));
        assert_eq!(parsed.time.as_deref(), Some("1937"));
        assert_eq!(parsed.service.as_deref(), Some("svc"));
        assert_eq!(parsed.instance.as_deref(), Some("host/one"));
        assert_eq!(parsed.boot_id, None);
    }

    #[test]
    fn missing_hive_fields_do_not_hide_present_fields() {
        let parsed = parse_segment_object_key(
            "traces/date=2026-08-14/region=uy/service=svc/1786736220-3.bin.gz",
        );
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Hive);
        assert_eq!(parsed.date.as_deref(), Some("2026-08-14"));
        assert_eq!(parsed.time, None);
        assert_eq!(parsed.service.as_deref(), Some("svc"));
        assert_eq!(parsed.instance, None);
        assert_eq!(parsed.boot_id, None);
    }

    #[test]
    fn malformed_hive_field_does_not_hide_other_fields() {
        let parsed = parse_segment_object_key(
            "service=prefix/date=2026-08-14/time=1937/service=bad%2/instance=host%2Fone/boot=boot/1786736220-3.bin.gz",
        );
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Hive);
        assert_eq!(parsed.service, None);
        assert_eq!(parsed.instance.as_deref(), Some("host/one"));
        assert_eq!(parsed.boot_id.as_deref(), Some("boot"));
        assert_eq!(parsed.epoch_secs, Some(1_786_736_220));
    }

    #[test]
    fn parses_both_historical_layouts() {
        let with_boot = parse_segment_object_key(
            "service=prefix/traces/2026-04-09/1910/service/host/boot/1744224000-3.bin.gz",
        );
        assert_eq!(with_boot.layout, SegmentObjectKeyLayout::PositionalWithBoot);
        assert_eq!(with_boot.service.as_deref(), Some("service"));
        assert_eq!(with_boot.instance.as_deref(), Some("host"));
        assert_eq!(with_boot.boot_id.as_deref(), Some("boot"));

        let legacy =
            parse_segment_object_key("traces/2026-04-09/1910/service/host/1744224000-3.bin.gz");
        assert_eq!(legacy.layout, SegmentObjectKeyLayout::PositionalWithoutBoot);
        assert_eq!(legacy.boot_id, None);
    }

    #[test]
    fn unknown_layout_keeps_filename_metadata() {
        let parsed = parse_segment_object_key("custom/path/1744224000-3.bin.gz");
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Unknown);
        assert_eq!(parsed.filename, "1744224000-3.bin.gz");
        assert_eq!(parsed.epoch_secs, Some(1_744_224_000));
        assert_eq!(parsed.segment_index, Some(3));
    }
}
