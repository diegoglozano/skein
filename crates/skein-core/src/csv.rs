//! Streaming CSV record scanner (REQUIREMENTS.md §4.1: parse in WASM, never
//! materialise the file).
//!
//! Chunk-oriented: `feed` accepts arbitrary byte slices — records and quoted
//! fields may span chunk boundaries. RFC 4180-ish: quoted fields may contain
//! the delimiter, newlines, and `""` escapes; CRLF and LF both end records; a
//! quote inside an unquoted field is a literal byte (non-strict, matches what
//! real-world edge lists contain).
//!
//! Field bytes are accumulated into one internal record buffer with an ends
//! array — flat, reused across records, no per-field allocation.

/// Scanner state between bytes.
#[derive(Clone, Copy, PartialEq)]
enum State {
    /// Outside quotes (field start or inside an unquoted field).
    Unquoted,
    /// Inside a quoted field.
    Quoted,
    /// Just saw a quote inside a quoted field: either `""` escape or close.
    QuoteInQuoted,
}

pub struct CsvScanner {
    delimiter: u8,
    state: State,
    /// Concatenated bytes of the current record's fields (quotes stripped).
    record: Vec<u8>,
    /// End offset in `record` of each completed field this record.
    ends: Vec<u32>,
    /// True once the current record has any bytes or completed fields —
    /// distinguishes a blank line from a record ending in an empty field.
    dirty: bool,
}

impl CsvScanner {
    pub fn new(delimiter: u8) -> Self {
        Self {
            delimiter,
            state: State::Unquoted,
            record: Vec::with_capacity(256),
            ends: Vec::with_capacity(8),
            dirty: false,
        }
    }

    /// Feed one chunk. `on_record(bytes, ends)` fires per completed record:
    /// field i is `bytes[ends[i-1]..ends[i]]` (`ends[-1]` read as 0). Blank
    /// lines are skipped entirely.
    pub fn feed<F: FnMut(&[u8], &[u32])>(&mut self, chunk: &[u8], mut on_record: F) {
        let mut i = 0;
        while i < chunk.len() {
            match self.state {
                State::Unquoted => {
                    // Bulk-copy the run up to the next byte that matters.
                    let start = i;
                    while i < chunk.len() {
                        let b = chunk[i];
                        if b == self.delimiter || b == b'\n' || b == b'\r' || b == b'"' {
                            break;
                        }
                        i += 1;
                    }
                    if i > start {
                        self.record.extend_from_slice(&chunk[start..i]);
                        self.dirty = true;
                    }
                    if i == chunk.len() {
                        break;
                    }
                    let b = chunk[i];
                    i += 1;
                    if b == self.delimiter {
                        self.ends.push(self.record.len() as u32);
                        self.dirty = true;
                    } else if b == b'\n' {
                        self.end_record(&mut on_record);
                    } else if b == b'"' {
                        if self.field_is_empty() {
                            self.state = State::Quoted;
                        } else {
                            // Literal quote mid-field (non-strict).
                            self.record.push(b'"');
                        }
                        self.dirty = true;
                    }
                    // \r: dropped; the \n that follows (if any) ends the record.
                }
                State::Quoted => {
                    let start = i;
                    while i < chunk.len() && chunk[i] != b'"' {
                        i += 1;
                    }
                    self.record.extend_from_slice(&chunk[start..i]);
                    if i < chunk.len() {
                        i += 1;
                        self.state = State::QuoteInQuoted;
                    }
                }
                State::QuoteInQuoted => {
                    if chunk[i] == b'"' {
                        self.record.push(b'"');
                        self.state = State::Quoted;
                    } else {
                        // Field closed; reprocess this byte as unquoted.
                        self.state = State::Unquoted;
                        continue;
                    }
                    i += 1;
                }
            }
        }
    }

    /// Flush a final record that wasn't newline-terminated (EOF).
    pub fn flush<F: FnMut(&[u8], &[u32])>(&mut self, mut on_record: F) {
        self.state = State::Unquoted;
        self.end_record(&mut on_record);
    }

    #[inline]
    fn field_is_empty(&self) -> bool {
        self.record.len() as u32 == self.ends.last().copied().unwrap_or(0)
    }

    #[inline]
    fn end_record<F: FnMut(&[u8], &[u32])>(&mut self, on_record: &mut F) {
        if self.dirty || !self.ends.is_empty() {
            self.ends.push(self.record.len() as u32);
            on_record(&self.record, &self.ends);
        }
        self.record.clear();
        self.ends.clear();
        self.dirty = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect records as Vec<Vec<String>> for assertion convenience.
    fn parse(chunks: &[&[u8]]) -> Vec<Vec<String>> {
        let mut out = Vec::new();
        let mut sc = CsvScanner::new(b',');
        let collect = |out: &mut Vec<Vec<String>>, bytes: &[u8], ends: &[u32]| {
            let mut fields = Vec::new();
            let mut start = 0usize;
            for &e in ends {
                fields.push(String::from_utf8_lossy(&bytes[start..e as usize]).into_owned());
                start = e as usize;
            }
            out.push(fields);
        };
        for c in chunks {
            sc.feed(c, |b, e| collect(&mut out, b, e));
        }
        sc.flush(|b, e| collect(&mut out, b, e));
        out
    }

    #[test]
    fn simple_records() {
        assert_eq!(
            parse(&[b"a,b\nc,d\n"]),
            vec![vec!["a", "b"], vec!["c", "d"]]
        );
    }

    #[test]
    fn missing_trailing_newline() {
        assert_eq!(parse(&[b"a,b\nc,d"]), vec![vec!["a", "b"], vec!["c", "d"]]);
    }

    #[test]
    fn crlf() {
        assert_eq!(
            parse(&[b"a,b\r\nc,d\r\n"]),
            vec![vec!["a", "b"], vec!["c", "d"]]
        );
    }

    #[test]
    fn record_spans_chunks() {
        assert_eq!(
            parse(&[b"al", b"ice,b", b"ob\nx,y\n"]),
            vec![vec!["alice", "bob"], vec!["x", "y"]]
        );
    }

    #[test]
    fn one_byte_chunks() {
        let data = b"aa,bb\ncc,dd\n";
        let chunks: Vec<&[u8]> = data.chunks(1).collect();
        assert_eq!(parse(&chunks), vec![vec!["aa", "bb"], vec!["cc", "dd"]]);
    }

    #[test]
    fn quoted_fields() {
        assert_eq!(parse(&[b"\"a,b\",c\n"]), vec![vec!["a,b", "c"]]);
    }

    #[test]
    fn quoted_embedded_newline_and_escape() {
        assert_eq!(
            parse(&[b"\"line1\nline2\",\"say \"\"hi\"\"\"\n"]),
            vec![vec!["line1\nline2", "say \"hi\""]]
        );
    }

    #[test]
    fn quote_spans_chunks() {
        assert_eq!(parse(&[b"\"a,", b"b\",c\n"]), vec![vec!["a,b", "c"]]);
    }

    #[test]
    fn literal_quote_mid_field() {
        assert_eq!(parse(&[b"a\"b,c\n"]), vec![vec!["a\"b", "c"]]);
    }

    #[test]
    fn blank_lines_skipped() {
        assert_eq!(
            parse(&[b"a,b\n\n\nc,d\n\n"]),
            vec![vec!["a", "b"], vec!["c", "d"]]
        );
    }

    #[test]
    fn empty_fields_kept() {
        assert_eq!(
            parse(&[b"a,,c\n,\n"]),
            vec![vec!["a", "", "c"], vec!["", ""]]
        );
    }

    #[test]
    fn empty_input() {
        assert_eq!(parse(&[b""]), Vec::<Vec<String>>::new());
    }
}
