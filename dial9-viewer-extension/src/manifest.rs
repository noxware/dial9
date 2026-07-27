/// Number of bytes left after removing JSON whitespace outside strings.
pub const fn compact_json_len(input: &[u8]) -> usize {
    let mut index = 0;
    let mut len = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < input.len() {
        let byte = input[index];
        if in_string {
            len += 1;
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
            len += 1;
        } else if !is_json_whitespace(byte) {
            len += 1;
        }
        index += 1;
    }
    len
}

/// Compact JSON without interpreting or rewriting string contents.
pub const fn compact_json<const N: usize>(input: &[u8]) -> [u8; N] {
    let mut output = [0; N];
    let mut input_index = 0;
    let mut output_index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while input_index < input.len() {
        let byte = input[input_index];
        let copy = if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            true
        } else if byte == b'"' {
            in_string = true;
            true
        } else {
            !is_json_whitespace(byte)
        };
        if copy {
            output[output_index] = byte;
            output_index += 1;
        }
        input_index += 1;
    }
    assert!(output_index == N, "manifest compacted length mismatch");
    output
}

const fn is_json_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_spaces_escapes_and_unicode_inside_strings() {
        const SOURCE: &str = "{\n \"a\": \"x y\\\\\\\"z\", \"emoji\": \"🔥\" \n}";
        const LEN: usize = compact_json_len(SOURCE.as_bytes());
        const COMPACT: [u8; LEN] = compact_json::<LEN>(SOURCE.as_bytes());
        assert_eq!(
            std::str::from_utf8(&COMPACT).unwrap(),
            r#"{"a":"x y\\\"z","emoji":"🔥"}"#,
        );
    }
}
