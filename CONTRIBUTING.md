# Contributing to claude-armory

Thanks for helping. This is a collection of small, finished, tested extensions for Claude Code, and contributions of every size are welcome: bug reports, fixes, documentation and whole new extensions.

## How changes get in

- `master` is protected. Nobody pushes to it directly, and only the maintainer merges pull requests.
- You work on a branch and open a pull request against `master`. If you do not have write access, fork the repository and open the pull request from your fork.
- The maintainer reviews and merges. Expect a few rounds of comments on larger changes.

## Before you start

- Open an issue first for a new extension or a large change, so we can agree on the shape before you spend time on it.
- Small fixes and documentation changes can go straight to a pull request.

## What belongs in the repository

Only finished, documented, tested code. The repository is public and many people install from it, so please do not include:

- research notes, plans, reports, scratch files or unfinished work,
- the `.claude/` folder (agent memory, settings, local state),
- secrets, tokens or `.env` files (use `.env.example` for the names of settings),
- generated or personal files.

`.gitignore` already covers most of these. Check `git status` and the staged file list before every commit.

## Adding an extension

1. Create `mods/<name>/` with a `.claude-plugin/plugin.json` (name, version, description).
2. Add `hooks/` for a mod or hooks, `skills/` for skills, and a `README.md` for the extension: what it does, install, commands, how it works.
3. Register it in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).
4. Add tests and make them pass:

   ```bash
   claude plugin test mods/<name>
   ```

5. Add a line to the catalog table in the root [README](README.md) and an entry to the [changelog](CHANGELOG.md).

## Changing an existing extension

- Keep pure logic apart from the hook wiring so it can be unit tested, and add a test for every behavior you change or fix.
- Bump the extension's version in its `plugin.json` and describe the change under it in the changelog.
- Update the extension's `README.md` when behavior or commands change.

## Commits and pull requests

- One topic per pull request. Keep the diff small and readable.
- Commit messages: a short summary line, starting with the extension, for example `usage-eta 0.2.1: fix the resume check`. Add a body that explains why.
- In the pull request, say what changed, why, and how you tested it.

## Reporting bugs and security issues

Open an issue for bugs and ideas. For security issues, do not open a public issue: follow [SECURITY.md](SECURITY.md).

## Working with an AI agent

[AGENTS.md](AGENTS.md) (also loaded as `CLAUDE.md`) tells an agent how this repository is laid out and what rules it must follow. Point your agent at it before it makes changes.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
