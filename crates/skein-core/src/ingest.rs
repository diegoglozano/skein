//! Streaming edge-list ingest: CSV chunks → interned ids → edge buffers → CSR.
//!
//! This is the algorithmic half of the ingest pipeline (§4.1); skein-wasm
//! exposes it across the boundary, the ingest worker feeds it `File.stream()`
//! chunks. Lives here so the whole path is natively testable and benchable.

use crate::csv::CsvScanner;
use crate::{Csr, Interner};

/// Column mapping and dialect for an edge-list CSV.
pub struct IngestConfig {
    pub delimiter: u8,
    /// Skip the first record, capturing it as column names.
    pub has_header: bool,
    pub source_col: usize,
    pub target_col: usize,
    /// Parsed as f32; rows with an unparsable weight are skipped and counted.
    pub weight_col: Option<usize>,
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            delimiter: b',',
            has_header: true,
            source_col: 0,
            target_col: 1,
            weight_col: None,
        }
    }
}

pub struct EdgeIngest {
    config: IngestConfig,
    scanner: CsvScanner,
    interner: Interner,
    sources: Vec<u32>,
    targets: Vec<u32>,
    weights: Vec<f32>,
    header: Option<Vec<String>>,
    header_pending: bool,
    /// Non-blank records that didn't yield an edge (too few columns, bad weight).
    skipped: u64,
}

/// Everything the ingest produces, in the flat persistable layout of §4.2.
pub struct IngestOutput {
    pub csr: Csr,
    /// Concatenated UTF-8 of all node ids.
    pub id_bytes: Vec<u8>,
    /// id i is `id_bytes[id_offsets[i]..id_offsets[i+1]]`; len == nodes + 1.
    pub id_offsets: Vec<u32>,
    pub header: Option<Vec<String>>,
    pub skipped: u64,
}

impl EdgeIngest {
    pub fn new(config: IngestConfig, expected_nodes: usize) -> Self {
        let header_pending = config.has_header;
        Self {
            scanner: CsvScanner::new(config.delimiter),
            interner: Interner::with_capacity(expected_nodes),
            sources: Vec::new(),
            targets: Vec::new(),
            weights: Vec::new(),
            header: None,
            header_pending,
            skipped: 0,
            config,
        }
    }

    pub fn node_count(&self) -> usize {
        self.interner.len()
    }

    pub fn edge_count(&self) -> usize {
        self.sources.len()
    }

    pub fn skipped_rows(&self) -> u64 {
        self.skipped
    }

    pub fn header(&self) -> Option<&[String]> {
        self.header.as_deref()
    }

    /// Feed one chunk of CSV bytes; chunk boundaries may fall anywhere.
    pub fn push_chunk(&mut self, chunk: &[u8]) {
        // Destructure so the scanner borrow and the sink borrows are disjoint.
        let Self {
            scanner,
            interner,
            sources,
            targets,
            weights,
            header,
            header_pending,
            skipped,
            config,
        } = self;
        scanner.feed(chunk, |bytes, ends| {
            Self::sink(
                bytes,
                ends,
                interner,
                sources,
                targets,
                weights,
                header,
                header_pending,
                skipped,
                config,
            )
        });
    }

    /// Flush the final unterminated record and build CSR + dictionary.
    pub fn finish(mut self) -> IngestOutput {
        let Self {
            scanner,
            interner,
            sources,
            targets,
            weights,
            header,
            header_pending,
            skipped,
            config,
        } = &mut self;
        scanner.flush(|bytes, ends| {
            Self::sink(
                bytes,
                ends,
                interner,
                sources,
                targets,
                weights,
                header,
                header_pending,
                skipped,
                config,
            )
        });

        let csr = Csr::from_edges(
            self.interner.len() as u32,
            &self.sources,
            &self.targets,
            self.config.weight_col.map(|_| &self.weights[..]),
        );
        let (id_bytes, id_offsets) = self.interner.into_dictionary();
        IngestOutput {
            csr,
            id_bytes,
            id_offsets,
            header: self.header,
            skipped: self.skipped,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn sink(
        bytes: &[u8],
        ends: &[u32],
        interner: &mut Interner,
        sources: &mut Vec<u32>,
        targets: &mut Vec<u32>,
        weights: &mut Vec<f32>,
        header: &mut Option<Vec<String>>,
        header_pending: &mut bool,
        skipped: &mut u64,
        config: &IngestConfig,
    ) {
        let field = |i: usize| -> Option<&[u8]> {
            if i >= ends.len() {
                return None;
            }
            let start = if i == 0 { 0 } else { ends[i - 1] as usize };
            Some(&bytes[start..ends[i] as usize])
        };

        if *header_pending {
            *header_pending = false;
            *header = Some(
                (0..ends.len())
                    .map(|i| String::from_utf8_lossy(field(i).unwrap()).into_owned())
                    .collect(),
            );
            return;
        }

        let (Some(s), Some(t)) = (field(config.source_col), field(config.target_col)) else {
            *skipped += 1;
            return;
        };
        let w = match config.weight_col {
            None => None,
            Some(col) => {
                let parsed = field(col)
                    .and_then(|f| std::str::from_utf8(f).ok())
                    .and_then(|f| f.trim().parse::<f32>().ok());
                match parsed {
                    Some(w) => Some(w),
                    None => {
                        *skipped += 1;
                        return;
                    }
                }
            }
        };

        sources.push(interner.intern(s));
        targets.push(interner.intern(t));
        if let Some(w) = w {
            weights.push(w);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ingest(chunks: &[&[u8]], config: IngestConfig) -> IngestOutput {
        let mut ing = EdgeIngest::new(config, 16);
        for c in chunks {
            ing.push_chunk(c);
        }
        ing.finish()
    }

    #[test]
    fn basic_edge_list() {
        let out = ingest(
            &[b"source,target\na,b\nb,c\na,c\n"],
            IngestConfig::default(),
        );
        assert_eq!(out.csr.node_count(), 3);
        assert_eq!(out.csr.edge_count(), 3);
        assert_eq!(
            out.header.as_deref(),
            Some(&["source".into(), "target".into()][..])
        );
        assert_eq!(out.skipped, 0);
        // a=0, b=1, c=2 in first-seen order; a→{b,c}, b→{c}.
        assert_eq!(out.csr.neighbors(0), &[1, 2]);
        assert_eq!(out.csr.neighbors(1), &[2]);
        assert_eq!(&out.id_bytes[..], b"abc");
        assert_eq!(out.id_offsets, vec![0, 1, 2, 3]);
    }

    #[test]
    fn no_header() {
        let out = ingest(
            &[b"a,b\nc,d\n"],
            IngestConfig {
                has_header: false,
                ..Default::default()
            },
        );
        assert_eq!(out.csr.node_count(), 4);
        assert_eq!(out.csr.edge_count(), 2);
        assert_eq!(out.header, None);
    }

    #[test]
    fn weights_parsed() {
        let out = ingest(
            &[b"s,t,w\na,b,0.5\nb,c,2\n"],
            IngestConfig {
                weight_col: Some(2),
                ..Default::default()
            },
        );
        assert_eq!(out.csr.edge_count(), 2);
        assert_eq!(out.csr.weights.as_deref(), Some(&[0.5, 2.0][..]));
    }

    #[test]
    fn malformed_rows_skipped_and_counted() {
        let out = ingest(
            &[b"s,t,w\na,b,1\nonlyonefield\nc,d,notanumber\ne,f,3\n"],
            IngestConfig {
                weight_col: Some(2),
                ..Default::default()
            },
        );
        assert_eq!(out.csr.edge_count(), 2);
        assert_eq!(out.skipped, 2);
        // Skipped rows must not have interned ids.
        assert_eq!(out.csr.node_count(), 4);
    }

    #[test]
    fn chunk_boundaries_anywhere() {
        let data = b"source,target\nnode-one,node-two\nnode-two,node-three\n";
        for split in 0..data.len() {
            let out = ingest(&[&data[..split], &data[split..]], IngestConfig::default());
            assert_eq!(out.csr.node_count(), 3, "split at {split}");
            assert_eq!(out.csr.edge_count(), 2, "split at {split}");
        }
    }

    #[test]
    fn custom_columns_and_delimiter() {
        let out = ingest(
            &[b"w\t s\tt\n1.0\ta\tb\n"],
            IngestConfig {
                delimiter: b'\t',
                source_col: 1,
                target_col: 2,
                weight_col: Some(0),
                ..Default::default()
            },
        );
        assert_eq!(out.csr.edge_count(), 1);
        assert_eq!(out.csr.weights.as_deref(), Some(&[1.0][..]));
    }

    #[test]
    fn matches_fixture_generator_format() {
        // bench/generate-fixtures.mjs writes "source,target\nn0,n1\n..."
        let out = ingest(
            &[b"source,target\nn0,n1\nn1,n2\nn0,n2\nn2,n0\n"],
            IngestConfig::default(),
        );
        assert_eq!(out.csr.node_count(), 3);
        assert_eq!(out.csr.edge_count(), 4);
    }

    #[test]
    fn deterministic_across_chunkings() {
        let mut data = String::from("source,target\n");
        for i in 0..500 {
            data.push_str(&format!("n{},n{}\n", i % 37, (i * 7) % 37));
        }
        let whole = ingest(&[data.as_bytes()], IngestConfig::default());
        let bytes = data.as_bytes();
        let chunks: Vec<&[u8]> = bytes.chunks(13).collect();
        let split = ingest(&chunks, IngestConfig::default());
        assert_eq!(whole.csr.offsets, split.csr.offsets);
        assert_eq!(whole.csr.targets, split.csr.targets);
        assert_eq!(whole.id_bytes, split.id_bytes);
    }
}
