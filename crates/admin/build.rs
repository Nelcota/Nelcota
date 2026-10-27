// Precompresses the embedded panel (`ui/dist`) once per build, so the server
// sends brotli or gzip bytes straight from the binary instead of compressing
// every asset on every request. The variants live in OUT_DIR and are never
// committed: the versioned `dist` stays the only source, and its drift check
// is unaffected.
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
};

/// Text formats worth compressing. Images and fonts are already compressed.
const COMPRESSIBLE_EXTENSIONS: &[&str] = &[
    "js", "mjs", "css", "html", "svg", "json", "wasm", "map", "txt",
];
/// Below this the saved bytes do not pay for a second representation.
const MIN_COMPRESSIBLE_BYTES: u64 = 256;
const BROTLI_QUALITY: u32 = 11;
/// Brotli's default window (4 MiB); every chunk fits in it.
const BROTLI_WINDOW_BITS: u32 = 22;
const BROTLI_BUFFER_BYTES: usize = 64 * 1024;
const GZIP_LEVEL: u32 = 9;
/// Matches the `jobs = 4` cap in `.cargo/config.toml`.
const MAX_THREADS: usize = 4;

struct Variant {
    /// Path relative to `ui/dist`, with `/` separators (the rust-embed key).
    path: String,
    file_stem: String,
}

fn main() {
    println!("cargo::rerun-if-changed=ui/dist");
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let dist = manifest.join("ui").join("dist");
    let target = out.join("precompressed");
    fs::create_dir_all(&target)
        .unwrap_or_else(|error| panic!("cannot create {}: {error}", target.display()));

    let mut files = Vec::new();
    collect(&dist, &dist, &mut files);
    // A stable order keeps the generated table sorted for binary search.
    files.sort();

    let next = AtomicUsize::new(0);
    let threads = thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(MAX_THREADS);
    let mut variants: Vec<(usize, Variant)> = thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(path) = files.get(index) else { break };
                        if let Some(variant) = compress(&dist, path, &target, index) {
                            done.push((index, variant));
                        }
                    }
                    done
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("a compression thread panicked"))
            .collect()
    });
    variants.sort_by_key(|(index, _)| *index);

    let mut table = String::from(
        "/// Precompressed panel files, sorted by path: (path, brotli, gzip).\n\
         static PRECOMPRESSED: &[(&str, &[u8], &[u8])] = &[\n",
    );
    for (_, variant) in &variants {
        let stem = &variant.file_stem;
        table.push_str(&format!(
            "    ({:?}, include_bytes!(concat!(env!(\"OUT_DIR\"), \"/precompressed/{stem}.br\")), include_bytes!(concat!(env!(\"OUT_DIR\"), \"/precompressed/{stem}.gz\"))),\n",
            variant.path,
        ));
    }
    table.push_str("];\n");
    let generated = out.join("precompressed.rs");
    fs::write(&generated, table)
        .unwrap_or_else(|error| panic!("cannot write {}: {error}", generated.display()));
}

fn collect(root: &Path, directory: &Path, files: &mut Vec<String>) {
    let entries = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", directory.display()));
    for entry in entries {
        let path = entry
            .unwrap_or_else(|error| {
                panic!("cannot read an entry of {}: {error}", directory.display())
            })
            .path();
        if path.is_dir() {
            collect(root, &path, files);
            continue;
        }
        let compressible = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| COMPRESSIBLE_EXTENSIONS.contains(&extension));
        let size = fs::metadata(&path).map_or(0, |metadata| metadata.len());
        if !compressible || size < MIN_COMPRESSIBLE_BYTES {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .expect("collected paths are inside dist");
        let key = relative
            .components()
            .map(|component| {
                component
                    .as_os_str()
                    .to_str()
                    .expect("dist paths are UTF-8")
            })
            .collect::<Vec<_>>()
            .join("/");
        files.push(key);
    }
}

/// Writes `<index>.br` and `<index>.gz`, or nothing when gzip does not shrink the file.
fn compress(dist: &Path, path: &str, target: &Path, index: usize) -> Option<Variant> {
    let original =
        fs::read(dist.join(path)).unwrap_or_else(|error| panic!("cannot read {path}: {error}"));

    let mut brotli = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(
            &mut brotli,
            BROTLI_BUFFER_BYTES,
            BROTLI_QUALITY,
            BROTLI_WINDOW_BITS,
        );
        writer
            .write_all(&original)
            .unwrap_or_else(|error| panic!("cannot brotli-compress {path}: {error}"));
    }

    // GzBuilder leaves the header timestamp at zero, so the output is reproducible.
    let mut gzip = flate2::GzBuilder::new().write(Vec::new(), flate2::Compression::new(GZIP_LEVEL));
    gzip.write_all(&original)
        .unwrap_or_else(|error| panic!("cannot gzip {path}: {error}"));
    let gzip = gzip
        .finish()
        .unwrap_or_else(|error| panic!("cannot gzip {path}: {error}"));

    if gzip.len() >= original.len() {
        return None;
    }
    let file_stem = index.to_string();
    for (extension, bytes) in [("br", &brotli), ("gz", &gzip)] {
        let output = target.join(format!("{file_stem}.{extension}"));
        fs::write(&output, bytes)
            .unwrap_or_else(|error| panic!("cannot write {}: {error}", output.display()));
    }
    Some(Variant {
        path: path.to_owned(),
        file_stem,
    })
}
