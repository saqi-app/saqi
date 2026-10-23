from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
paths = sorted((root / "typescript/scripts").rglob("*.test.py"))
paths += sorted((root / "macos").rglob("*.test.py"))
paths += sorted((root / ".github/scripts").glob("*.test.py"))
for path in paths:
    subprocess.run([sys.executable, str(path)], cwd=root, check=True)
for path in sorted((root / ".github/scripts").glob("*.test.sh")):
    subprocess.run(["bash", str(path)], cwd=root, check=True)
