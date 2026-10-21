//! A database dump and its immutable, checked file snapshot form one backup.

use crate::project::Project;
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
mod files;
mod remote;
pub(crate) use remote::{
    publish_remote, s3_configured, test_remote, valid_destination, verify_remote,
};
mod verification;
pub(crate) use verification::{latest_verified, verify_copy};
mod workflow;
#[cfg(test)]
pub(crate) use workflow::prune;
pub(crate) use workflow::{backup as run, latest, restore, restore_dump};

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Stdio},
};

#[derive(Deserialize)]
struct Object {
    key: String,
    size: u64,
}
#[derive(Serialize, Deserialize)]
pub struct FileRecord {
    key: String,
    size: u64,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
pub struct Manifest {
    format: u8,
    dump: String,
    objects: Vec<FileRecord>,
}

pub fn bundle_path(dump: &Path) -> anyhow::Result<PathBuf> {
    let name = dump
        .file_name()
        .and_then(|v| v.to_str())
        .context("invalid dump filename")?;
    Ok(dump.with_file_name(format!("{name}.files")))
}

/// psql owns the exported snapshot and the SHARE lock until capture finishes.
/// Writers wait, reads and transfers continue, and pg_dump sees the same rows
/// as the file manifest. Closing stdin releases the transaction on every exit.
struct Snapshot {
    process: Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Snapshot {
    fn open(project: &Project) -> anyhow::Result<Self> {
        let mut process = project
            .as_postgres(&["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", "postgres"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let output = BufReader::new(process.stdout.take().context("missing snapshot output")?);
        let mut snapshot = Self { process, output };
        snapshot.process.stdin.as_mut().context("missing snapshot input")?.write_all(
            b"BEGIN ISOLATION LEVEL REPEATABLE READ;\nSET LOCAL lock_timeout='30s';\nLOCK TABLE storage.objects IN SHARE MODE;\nSELECT pg_export_snapshot();\nSELECT coalesce(json_agg(json_build_object('key',bucket_id || '/' || version,'size',size)), '[]') FROM storage.objects;\n"
        )?;
        Ok(snapshot)
    }
    fn line(&mut self) -> anyhow::Result<String> {
        let mut line = String::new();
        if self.output.read_line(&mut line)? == 0 {
            bail!("could not capture the database snapshot (see psql error)");
        }
        Ok(line.trim().to_owned())
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        if let Some(mut input) = self.process.stdin.take() {
            let _ = input.write_all(b"ROLLBACK;\n\\q\n");
        }
        let _ = self.process.wait();
    }
}

fn object_path(root: &Path, key: &str) -> anyhow::Result<PathBuf> {
    let parts: Vec<_> = key.split('/').collect();
    if parts.len() != 2
        || !(1..=63).contains(&parts[0].len())
        || !parts[0]
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
        || uuid::Uuid::parse_str(parts[1]).is_err()
    {
        bail!("invalid file key in backup manifest");
    }
    Ok(root.join(parts[0]).join(parts[1]))
}

fn checksum(path: &Path) -> anyhow::Result<(u64, String)> {
    let mut file =
        fs::File::open(path).with_context(|| format!("missing backup file {}", path.display()))?;
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        digest.update(&buffer[..read]);
    }
    // sha2 0.11's digest array has no hex formatting of its own.
    let hex = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((size, hex))
}

fn dump(project: &Project, path: &Path, snapshot: Option<&str>) -> anyhow::Result<()> {
    let mut command = project.as_postgres(&["pg_dump", "-Fc", "postgres"]);
    if let Some(snapshot) = snapshot {
        command.arg(format!("--snapshot={snapshot}"));
    }
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(crate::private_fs::file(path)?))
        .status()?;
    if !status.success() || fs::metadata(path)?.len() == 0 {
        bail!("pg_dump failed ({status})");
    }
    Ok(())
}

pub fn capture(project: &Project, path: &Path) -> anyhow::Result<()> {
    crate::private_fs::dir(path.parent().context("invalid backup directory")?)?;
    if path.exists() || bundle_path(path)?.exists() {
        bail!("backup already exists: {}", path.display());
    }
    let partial = path.with_extension("dump.partial");
    let bundle = bundle_path(path)?;
    let result = (|| {
        match project.stores_files_on_disk()? {
            true => {
                let mut snapshot = Snapshot::open(project)?;
                let id = snapshot.line()?;
                if !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') || id.is_empty() {
                    bail!("invalid exported snapshot");
                }
                let objects: Vec<Object> = serde_json::from_str(&snapshot.line()?)?;
                let root = bundle.join("objects");
                crate::private_fs::dir(&bundle)?;
                crate::private_fs::dir(&root)?;
                let mut records = Vec::with_capacity(objects.len());
                for object in objects {
                    let mut source = files::read(&project.storage_dir(), &object.key)?;
                    let destination = object_path(&root, &object.key)?;
                    crate::private_fs::dir(
                        destination.parent().context("invalid object directory")?,
                    )?;
                    crate::private_fs::copy_reader(&mut source, &destination, object.size)
                        .with_context(|| format!("could not snapshot {}", object.key))?;
                    let (size, sha256) = checksum(&destination)?;
                    if size != object.size {
                        bail!("file size changed during backup: {}", object.key);
                    }
                    records.push(FileRecord {
                        key: object.key,
                        size,
                        sha256,
                    });
                }
                dump(project, &partial, Some(&id))?;
                let manifest = Manifest {
                    format: 1,
                    dump: path
                        .file_name()
                        .context("invalid dump name")?
                        .to_string_lossy()
                        .into_owned(),
                    objects: records,
                };
                crate::private_fs::write(
                    &bundle.join("manifest.json"),
                    serde_json::to_vec_pretty(&manifest)?,
                )?;
            }
            false => {
                dump(project, &partial, None)?;
            }
        }
        fs::rename(&partial, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
        remove_bundle(path)?;
    }
    result
}

/// Check every file before restore changes the database.
pub fn validate(dump: &Path) -> anyhow::Result<Manifest> {
    let bundle = bundle_path(dump)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(bundle.join("manifest.json"))
        .context("this backup has no file manifest; restore the database without --files or fetch its matching snapshot")?)?;
    if manifest.format != 1
        || Some(manifest.dump.as_str()) != dump.file_name().and_then(|v| v.to_str())
    {
        bail!("file manifest does not belong to this dump");
    }
    for file in &manifest.objects {
        let (size, hash) = checksum(&object_path(&bundle.join("objects"), &file.key)?)?;
        if size != file.size || hash != file.sha256 {
            bail!("backup file failed verification: {}", file.key);
        }
    }
    Ok(manifest)
}

/// Project removal archives the complete pair before deleting live storage.
pub fn archive(dump: &Path, destination: &Path) -> anyhow::Result<()> {
    crate::private_fs::dir(destination.parent().context("invalid archive directory")?)?;
    let source = bundle_path(dump)?;
    if source.exists() {
        let manifest = validate(dump)?;
        let target = bundle_path(destination)?;
        if target.exists() {
            bail!("archived snapshot already exists");
        }
        crate::private_fs::dir(&target)?;
        crate::private_fs::dir(&target.join("objects"))?;
        for file in manifest.objects {
            let to = object_path(&target.join("objects"), &file.key)?;
            crate::private_fs::dir(to.parent().context("invalid archive path")?)?;
            crate::private_fs::copy(object_path(&source.join("objects"), &file.key)?, to)?;
        }
        crate::private_fs::copy(source.join("manifest.json"), target.join("manifest.json"))?;
        validate(destination)?;
    }
    crate::private_fs::copy(dump, destination)?;
    Ok(())
}

/// Existing extra versions remain inaccessible and are removed by the normal
/// orphan collector. Restoring a backup never erases another backup's bytes.
pub fn restore_files(project: &Project, dump: &Path, manifest: &Manifest) -> anyhow::Result<()> {
    let target = project.storage_dir();
    fs::create_dir_all(&target)?;
    let source = bundle_path(dump)?.join("objects");
    for file in &manifest.objects {
        files::restore(
            &target,
            &file.key,
            files::read(&source, &file.key)?,
            file.size,
        )?;
    }
    Ok(())
}

pub fn remove_bundle(dump: &Path) -> anyhow::Result<()> {
    let bundle = bundle_path(dump)?;
    if bundle.exists() {
        let parent = fs::canonicalize(dump.parent().context("invalid backup directory")?)?;
        let resolved = fs::canonicalize(&bundle)?;
        if resolved.parent() != Some(parent.as_path())
            || fs::symlink_metadata(&bundle)?.file_type().is_symlink()
        {
            bail!("backup snapshot escaped its directory");
        }
        fs::remove_dir_all(bundle)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_rejects_traversal() {
        assert!(object_path(Path::new("files"), "../x").is_err());
        assert!(object_path(Path::new("files"), "bucket/../../x").is_err());
        assert!(object_path(Path::new("files"), "bucket/not-a-version").is_err());
        assert_eq!(
            bundle_path(Path::new("backups/a.dump")).unwrap(),
            Path::new("backups/a.dump.files")
        );
    }

    struct Fixture {
        project: Project,
        _dir: tempfile::TempDir,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self
                .project
                .compose(&["down", "--volumes", "--remove-orphans"]);
        }
    }

    #[test]
    fn historical_snapshot_survives_replacement_restore_corruption_and_retention() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("nelcota-backup-test-{}", uuid::Uuid::new_v4());
        fs::write(dir.path().join("docker-compose.yml"), format!(
            "name: {name}\nservices:\n  postgres:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_HOST_AUTH_METHOD: trust\n"
        )).unwrap();
        fs::write(dir.path().join(".env"), "NELCOTA_STORAGE_BACKEND=disk\n").unwrap();
        let fixture = Fixture {
            project: Project::new(&name, dir.path(), crate::host::Runtime::Docker),
            _dir: dir,
        };
        let project = &fixture.project;
        project.compose_ok(&["up", "-d"]).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(40);
        loop {
            // Over TCP: the image's init runs a temporary server on the socket
            // only and then restarts it, so a socket check can pass just before
            // that restart.
            if project
                .as_postgres(&["pg_isready", "-q", "-h", "127.0.0.1"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "backup test Postgres did not start"
            );
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let run = |query: &str| {
            let output = project
                .as_postgres(&[
                    "psql",
                    "-XqAt",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-d",
                    "postgres",
                    "-c",
                    query,
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        let old = uuid::Uuid::new_v4();
        let new = uuid::Uuid::new_v4();
        run(&format!(
            "CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id text, version uuid, size bigint); INSERT INTO storage.objects VALUES('docs','{old}',3)"
        ));
        let source = project.storage_dir().join("docs");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(old.to_string()), b"old").unwrap();
        let backups = project.path("backups");
        fs::create_dir_all(&backups).unwrap();
        let a = backups.join("a.dump");
        let b = backups.join("b.dump");
        capture(project, &a).unwrap();
        fs::write(source.join(new.to_string()), b"new").unwrap();
        run(&format!("UPDATE storage.objects SET version='{new}'"));
        fs::remove_file(source.join(old.to_string())).unwrap();
        capture(project, &b).unwrap();
        let archive_dir = project.path("archive");
        fs::create_dir_all(&archive_dir).unwrap();
        let archived = archive_dir.join("a.dump");
        archive(&a, &archived).unwrap();
        let manifest = validate(&a).unwrap();
        crate::backup::restore_dump(project, &a).unwrap();
        restore_files(project, &a, &manifest).unwrap();
        assert_eq!(run("SELECT version FROM storage.objects"), old.to_string());
        assert_eq!(fs::read(source.join(old.to_string())).unwrap(), b"old");
        assert!(
            source.join(new.to_string()).exists(),
            "restore should not erase unrelated versions"
        );
        let old_copy = object_path(
            &bundle_path(&a).unwrap().join("objects"),
            &format!("docs/{old}"),
        )
        .unwrap();
        fs::write(&old_copy, b"bad").unwrap();
        assert!(validate(&a).is_err());
        assert!(
            validate(&archived).is_ok(),
            "archives must retain an independent snapshot"
        );
        assert_eq!(run("SELECT version FROM storage.objects"), old.to_string());
        fs::write(&old_copy, b"old").unwrap();
        let manifest_path = bundle_path(&a).unwrap().join("manifest.json");
        let mut manifest = validate(&a).unwrap();
        manifest.dump = "another.dump".into();
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(validate(&a).is_err());
        crate::backup::prune(&backups, 1).unwrap();
        assert!(!a.exists());
        assert!(!bundle_path(&a).unwrap().exists());
        assert!(validate(&b).is_ok());
    }
}
