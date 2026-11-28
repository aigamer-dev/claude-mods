# Security policy

## Supported versions

Security fixes go into the latest version of each extension on `master`. Older versions are not patched; please update.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include what you found, the extension and version, steps to reproduce, and the impact you expect. You will get a reply as soon as the maintainer can, and the report stays private until a fix is available.

## What to know about these extensions

Extensions here run inside Claude Code with your user's permissions. Hooks can read and change files and run commands, so install only what you have read or trust.

- **The usage-eta command allowlist is not a sandbox.** While its limit guard is active it restricts a model to read-only commands so that it stops starting new work. That steers an honest model; it is not a security boundary against hostile input. Reports that show a way around it are welcome, and are treated as hardening unless they cross a real boundary.
- **Files outside the project.** `/usage-eta-setup` edits only the marked block in `~/.claude/CLAUDE.md`, makes a dated backup first, and refuses to change a file whose markers are not one clean pair.
- **No secrets.** The extensions do not need API keys or tokens. Never commit credentials to this repository.

## Scope

In scope: code in this repository, and the marketplace manifest. Out of scope: Claude Code itself, other plugins and marketplaces, and your own configuration. Report those to their owners.
