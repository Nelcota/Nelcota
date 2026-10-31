"""Build a consumer against the .crate archive, outside the repository workspace."""
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import tomllib

root = Path(__file__).resolve().parents[3]
manifest = tomllib.loads((root / "sdk/rust/Cargo.toml").read_text(encoding="utf-8"))
name, version = manifest["package"]["name"], manifest["package"]["version"]
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--format-version", "1", "--no-deps", "--offline"],
    cwd=root, text=True,
))
archive = Path(metadata["target_directory"]) / "package" / f"{name}-{version}.crate"
if not archive.is_file():
    raise SystemExit(f"Run cargo package -p nelcota-client first: missing {archive}")

print(f"Verifying archive: {archive}", flush=True)

with tempfile.TemporaryDirectory(prefix="nelcota-rust-consumer-") as directory:
    directory = Path(directory)
    with tarfile.open(archive) as source:
        source.extractall(directory, filter="data")
    sdk = directory / f"{name}-{version}"
    consumer = directory / "consumer"
    (consumer / "src").mkdir(parents=True)
    (consumer / "Cargo.toml").write_text(
        '[package]\nname = "nelcota-sdk-consumer"\nversion = "0.0.0"\nedition = "2024"\n'
        '[dependencies]\nnelcota-client = { path = ' + json.dumps(sdk.as_posix()) + ' }\n'
        'serde_json = "1"\n', encoding="utf-8"
    )
    (consumer / "src/main.rs").write_text('''
use nelcota_client::{Client, Field, rest::{Condition, Order}, storage::UploadOptions};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder("https://api.example.com/prefix").build()?;
    let scoped = client.with_access_token("caller-token");
    let query = scoped.from("notes").select("id,body")
        .or([Condition::eq("body", "a,b)"), Condition::gt("id", 0)])
        .order("id", Order::descending()).range(0, 9);
    assert!(query.query_string()?.contains("select="));
    assert!(scoped.storage().from("files")?.public_url("a b.txt")?.as_str().contains("a%20b.txt"));
    let _options = UploadOptions::default();
    let field: Field<Option<String>> = Field::Value(None);
    assert!(!field.is_omitted());
    assert_eq!(serde_json::to_string(&field)?, "null");
    // A bare Omit (no skip_serializing_if) is refused rather than sent as null.
    assert!(serde_json::to_string(&Field::<Option<String>>::Omit).is_err());
    assert_eq!(nelcota_client::escape_like("a*"), "a\\\\*");
    println!("Published archive consumer works");
    Ok(())
}
''', encoding="utf-8")
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(root / "target/rust-sdk-consumer")
    subprocess.run(["cargo", "run", "--offline", "--manifest-path", str(consumer / "Cargo.toml")], env=environment, check=True)
