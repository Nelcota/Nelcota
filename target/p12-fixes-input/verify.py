import hashlib,json,subprocess
from pathlib import Path
p=Path('target/p12-fixes-input');m=json.loads((p/'manifest.json').read_text());b=p/'nelcota'
assert b.is_file() and not b.is_symlink() and b.stat().st_size==m['binary_bytes']<64*1024**2
assert hashlib.sha256(b.read_bytes()).hexdigest()==m['binary_sha256']
assert hashlib.sha256((p/'cli-tests').read_bytes()).hexdigest()==m['test_binary_sha256']
for path,sha in m['production_trees'].items():
 assert subprocess.check_output(['git','rev-parse','HEAD:'+path],text=True).strip()==sha
assert subprocess.check_output(['git','rev-parse','HEAD:crates/cli'],text=True).strip()==m['cli_test_tree']
print(json.dumps({'production_source_commit':m['source_commit'],'binary_sha256':m['binary_sha256'],'source_trees_match':True,'scope':m['scope']}))
