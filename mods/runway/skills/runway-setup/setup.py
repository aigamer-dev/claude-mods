#!/usr/bin/env python3
"""Adds, updates or removes the runway block in a CLAUDE.md, idempotently, with a backup.

Usage: setup.py [--file PATH] [--remove] [--dry-run]
Default file: $CLAUDE_CONFIG_DIR/CLAUDE.md, else ~/.claude/CLAUDE.md. The block sits
between two marker lines, so a second run replaces it in place and --remove takes
exactly that block out again and nothing else.

It stops with exit code 2 and changes nothing when the markers are not one clean
pair (a lone, reversed or repeated marker), or when the file already has a
runway section without markers: pairing them blindly could duplicate the rules
or delete text the person wrote.
"""
import argparse, datetime, os, re, shutil, sys, tempfile

BEGIN_PREFIX = "<!-- runway:begin"
BEGIN = BEGIN_PREFIX + " (managed by the runway plugin; run /runway-setup to update) -->"
END = "<!-- runway:end -->"
# The block written while the plugin was still called usage-eta is recognised and rewritten under the new name.
LEGACY_BEGIN_PREFIX = "<!-- usage-eta:begin"
LEGACY_END = "<!-- usage-eta:end -->"
UNMARKED = re.compile(r"^#{1,6}\s+(?:runway|usage-eta):", re.IGNORECASE)


def default_file() -> str:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(base, "CLAUDE.md")


def find_block(lines):
    """(begin, end) line indexes of the one marked block, or None; raises ValueError on a bad marker layout."""
    begins = [n for n, l in enumerate(lines) if l.strip().startswith((BEGIN_PREFIX, LEGACY_BEGIN_PREFIX))]
    ends = [n for n, l in enumerate(lines) if l.strip() in (END, LEGACY_END)]
    if not begins and not ends:
        if any(UNMARKED.match(l) for l in lines):
            raise ValueError(
                "the file has a runway section without markers; wrap it in "
                f"{BEGIN_PREFIX} ... --> and {END} lines (or delete it) and run again"
            )
        return None
    if len(begins) != 1 or len(ends) != 1 or begins[0] > ends[0]:
        raise ValueError(
            f"expected one '{BEGIN_PREFIX}' (or legacy '{LEGACY_BEGIN_PREFIX}') line followed by one '{END}' "
            f"(or '{LEGACY_END}') line, found "
            f"{len(begins)} begin and {len(ends)} end marker(s); fix them by hand and run again"
        )
    return begins[0], ends[0]


def write_atomic(path: str, text: str, mode: int) -> None:
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".CLAUDE.md.", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=default_file())
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    a.file = os.path.realpath(a.file)  # a symlinked CLAUDE.md keeps its link: the target is what is replaced
    here = os.path.dirname(os.path.abspath(__file__))
    block = open(os.path.join(here, "claude-md-block.md"), encoding="utf-8").read().strip()
    exists = os.path.exists(a.file)
    text = open(a.file, encoding="utf-8", newline="").read() if exists else ""
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl) if text else []
    try:
        found = find_block(lines)
    except ValueError as err:
        print(f"runway setup: {a.file}: {err}", file=sys.stderr)
        return 2
    fresh = [BEGIN, *block.splitlines(), END]
    if a.remove:
        if not found:
            print("runway block not present in", a.file)
            return 0
        b, e = found
        if b > 0 and lines[b - 1].strip() == "":
            b -= 1  # the blank line the block was appended after
        out = lines[:b] + lines[e + 1:]
    elif found:
        b, e = found
        out = lines[:b] + fresh + lines[e + 1:]
    else:
        out = list(lines)
        while out and out[-1].strip() == "":
            out.pop()
        out = out + ([""] if out else []) + fresh + [""]
    new = nl.join(out)
    if new == text:
        print("runway block already up to date in", a.file)
        return 0
    if a.dry_run:
        print("would update", a.file)
        return 0
    if exists:
        bak = f"{a.file}.bak-{datetime.datetime.now().strftime('%Y-%m-%d-%H%M%S')}"
        shutil.copy2(a.file, bak)
        print("backup:", bak)
    mode = os.stat(a.file).st_mode & 0o777 if exists else 0o600
    write_atomic(a.file, new, mode)
    print(("removed from " if a.remove else "updated ") + a.file)
    return 0


sys.exit(main())
