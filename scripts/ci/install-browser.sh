#!/usr/bin/env bash
set -euo pipefail
# Hosted Ubuntu's Azure mirror can stall long enough to consume the entire
# 15-minute Verify budget. Keep every Playwright dependency, using Ubuntu's
# primary mirror and bounded network waits instead.
if [ -d /etc/apt/sources.list.d ]; then
  sudo python3 - <<'PYAPT'
from pathlib import Path
for path in [Path('/etc/apt/sources.list'), *Path('/etc/apt').glob('*mirrors*.txt'), *Path('/etc/apt/sources.list.d').glob('*.sources'), *Path('/etc/apt/sources.list.d').glob('*.list')]:
    if path.is_file():
        source = path.read_text()
        updated = source.replace('http://azure.archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu').replace('https://azure.archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu')
        if updated != source:
            path.write_text(updated)
Path('/etc/apt/apt.conf.d/99-coaster-ci-timeouts').write_text('Acquire::Retries "2";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n')
PYAPT
fi
pnpm exec playwright install --with-deps --only-shell chromium
