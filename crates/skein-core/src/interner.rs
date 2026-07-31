//! String → u32 interning with an open-addressing hash table.
//!
//! This is the ingest hot spot (REQUIREMENTS.md §4.1). Interned strings are
//! stored as one concatenated byte buffer plus an offsets array — the same
//! layout the dictionary is persisted in — so finishing the interner is a
//! move, not a copy.

/// Sentinel for an empty hash-table slot.
const EMPTY: u32 = u32::MAX;
/// Grow when len > capacity * LOAD_NUM / LOAD_DEN.
const LOAD_NUM: usize = 7;
const LOAD_DEN: usize = 10;

const FX_SEED: u64 = 0x517c_c1b7_2722_0a95;

#[inline]
fn fx_hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0;
    let mut chunks = bytes.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes(c.try_into().unwrap());
        h = (h.rotate_left(5) ^ w).wrapping_mul(FX_SEED);
    }
    let rem = chunks.remainder();
    if !rem.is_empty() {
        let mut w = [0u8; 8];
        w[..rem.len()].copy_from_slice(rem);
        h = (h.rotate_left(5) ^ u64::from_le_bytes(w)).wrapping_mul(FX_SEED);
    }
    // FxHash concentrates entropy in the high bits while the table is indexed
    // by the low bits; without this finalizer (murmur3 fmix64) near-sequential
    // ids cluster into long probe chains and interning goes quadratic.
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    h ^ (h >> 33)
}

pub struct Interner {
    /// Concatenated UTF-8 of all interned ids.
    bytes: Vec<u8>,
    /// offsets[i]..offsets[i+1] delimits id i in `bytes`. len == count + 1.
    offsets: Vec<u32>,
    /// Open-addressing table of indices into `offsets`, EMPTY = free.
    table: Vec<u32>,
    mask: usize,
}

impl Interner {
    pub fn new() -> Self {
        Self::with_capacity(1 << 16)
    }

    /// `capacity` is the expected number of distinct ids.
    pub fn with_capacity(capacity: usize) -> Self {
        let table_len = (capacity * LOAD_DEN / LOAD_NUM + 1)
            .next_power_of_two()
            .max(16);
        Self {
            bytes: Vec::with_capacity(capacity * 8),
            offsets: vec![0],
            table: vec![EMPTY; table_len],
            mask: table_len - 1,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline]
    pub fn get(&self, index: u32) -> &[u8] {
        let start = self.offsets[index as usize] as usize;
        let end = self.offsets[index as usize + 1] as usize;
        &self.bytes[start..end]
    }

    /// Intern `id`, returning its dense u32 index. Existing ids return their
    /// original index.
    #[inline]
    pub fn intern(&mut self, id: &[u8]) -> u32 {
        let mut slot = fx_hash(id) as usize & self.mask;
        loop {
            let entry = self.table[slot];
            if entry == EMPTY {
                let index = self.len() as u32;
                self.table[slot] = index;
                self.bytes.extend_from_slice(id);
                self.offsets.push(self.bytes.len() as u32);
                if self.len() * LOAD_DEN > self.table.len() * LOAD_NUM {
                    self.grow();
                }
                return index;
            }
            if self.get(entry) == id {
                return entry;
            }
            slot = (slot + 1) & self.mask;
        }
    }

    /// Look up without inserting.
    pub fn lookup(&self, id: &[u8]) -> Option<u32> {
        let mut slot = fx_hash(id) as usize & self.mask;
        loop {
            let entry = self.table[slot];
            if entry == EMPTY {
                return None;
            }
            if self.get(entry) == id {
                return Some(entry);
            }
            slot = (slot + 1) & self.mask;
        }
    }

    #[cold]
    fn grow(&mut self) {
        let new_len = self.table.len() * 2;
        let mask = new_len - 1;
        let mut table = vec![EMPTY; new_len];
        for index in 0..self.len() as u32 {
            let mut slot = fx_hash(self.get(index)) as usize & mask;
            while table[slot] != EMPTY {
                slot = (slot + 1) & mask;
            }
            table[slot] = index;
        }
        self.table = table;
        self.mask = mask;
    }

    /// Consume the interner, yielding the persistable dictionary layout
    /// (REQUIREMENTS.md §4.2): concatenated bytes + offsets.
    pub fn into_dictionary(self) -> (Vec<u8>, Vec<u32>) {
        (self.bytes, self.offsets)
    }
}

impl Default for Interner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interns_and_dedupes() {
        let mut it = Interner::new();
        assert_eq!(it.intern(b"alice"), 0);
        assert_eq!(it.intern(b"bob"), 1);
        assert_eq!(it.intern(b"alice"), 0);
        assert_eq!(it.len(), 2);
        assert_eq!(it.get(0), b"alice");
        assert_eq!(it.get(1), b"bob");
    }

    #[test]
    fn lookup_does_not_insert() {
        let mut it = Interner::new();
        it.intern(b"x");
        assert_eq!(it.lookup(b"x"), Some(0));
        assert_eq!(it.lookup(b"y"), None);
        assert_eq!(it.len(), 1);
    }

    #[test]
    fn survives_growth() {
        let mut it = Interner::with_capacity(4);
        let n = 100_000u32;
        for i in 0..n {
            let s = format!("node-{i}");
            assert_eq!(it.intern(s.as_bytes()), i);
        }
        for i in 0..n {
            let s = format!("node-{i}");
            assert_eq!(it.lookup(s.as_bytes()), Some(i));
            assert_eq!(it.get(i), s.as_bytes());
        }
    }

    #[test]
    fn empty_and_binary_ids() {
        let mut it = Interner::new();
        assert_eq!(it.intern(b""), 0);
        assert_eq!(it.intern(&[0xff, 0x00, 0x7f]), 1);
        assert_eq!(it.intern(b""), 0);
        assert_eq!(it.get(1), &[0xff, 0x00, 0x7f]);
    }

    #[test]
    fn dictionary_roundtrip() {
        let mut it = Interner::new();
        it.intern(b"a");
        it.intern(b"bc");
        let (bytes, offsets) = it.into_dictionary();
        assert_eq!(bytes, b"abc");
        assert_eq!(offsets, vec![0, 1, 3]);
    }
}
