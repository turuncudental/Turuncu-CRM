#!/bin/bash
set -euo pipefail

# Configure git author for verified commits
git config user.email noreply@anthropic.com
git config user.name Claude

# Set up SSH signing verification so commits show B/E instead of N
ALLOWED_SIGNERS="$HOME/.ssh/allowed_signers"
SIGNING_KEY="$HOME/.ssh/commit_signing_key.pub"

# Make a signed test blob to extract the current session's public key
TEST_SIG=$(echo "test" | git hash-object --stdin | xargs git cat-file blob 2>/dev/null || true)
RECENT_SIG=$(git log --format='%H' -1 2>/dev/null || true)
if [[ -n "$RECENT_SIG" ]]; then
  PUB_KEY_B64=$(git cat-file -p "$RECENT_SIG" 2>/dev/null | python3 -c "
import sys, base64, struct
data = b''
in_sig = False
for line in sys.stdin:
    if 'BEGIN SSH SIGNATURE' in line: in_sig = True; continue
    if 'END SSH SIGNATURE' in line: break
    if in_sig: data += line.strip().encode()
if not data: sys.exit(1)
raw = base64.b64decode(data)
pos = 10  # skip magic(6) + version(4)
klen = struct.unpack('>I', raw[pos:pos+4])[0]; pos += 4
pub = raw[pos:pos+klen]
print(base64.b64encode(pub).decode())
" 2>/dev/null || true)
  if [[ -n "$PUB_KEY_B64" ]]; then
    echo "ssh-ed25519 $PUB_KEY_B64" > "$SIGNING_KEY"
    echo "noreply@anthropic.com ssh-ed25519 $PUB_KEY_B64" > "$ALLOWED_SIGNERS"
    git config --global gpg.ssh.allowedSignersFile "$ALLOWED_SIGNERS"
  fi
fi
