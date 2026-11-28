<div align="center">

# claude-armory

**Mods, skills, plugins and hooks that make Claude Code work the way you do.**

[Catalog](#catalog) · [Quick start](#quick-start) · [How it fits together](#how-it-fits-together) · [Contributing](#contributing)

</div>

claude-armory is a collection of small, focused extensions for [Claude Code](https://claude.com/claude-code) on the desktop app and the CLI. Each one solves one problem, installs on its own from a single marketplace, and is tested.

## Catalog

| Extension | Type | What it gives you |
|---|---|---|
| [**usage-eta**](mods/usage-eta) | Mod, skill, hooks | See your 5-hour and weekly limits live, get a self-calibrating ETA for your tasks, and let a limit guard pause and resume your work safely when the window runs out |

More extensions are added over time. Each lives in its own folder under [`mods/`](mods).

## Quick start

1. Add the marketplace:

   ```bash
   claude plugin marketplace add aigamer-dev/claude-armory
   ```

2. Install what you want:

   ```bash
   claude plugin install usage-eta@claude-armory
   ```

3. Restart Claude Code so it loads the new extension.

To work from a local clone instead, add the marketplace by path:

```bash
git clone https://github.com/aigamer-dev/claude-armory.git
claude plugin marketplace add ./claude-armory
```

## Featured: usage-eta

Know before you run out. usage-eta puts your usage limits, your task list and a forecast side by side, and learns how long your work really takes.

- **Live limits and forecast.** The 5-hour and weekly limits, a task tracker (including [EGM](https://github.com/google/elephant-goldfish-model) subagent steps), and an ETA with a token estimate and a "fits in the 5-hour window" verdict.
- **Learns from you.** The estimator calibrates itself from finished tasks, turns and agent runs, so its estimates get closer to your real pace.
- **A limit guard that does not lose your work.** When the window is nearly spent and the work will not fit, it lets running work checkpoint, writes an after-action report, pauses, and resumes from that report after the reset.
- **Works at any depth.** The guard follows every agent however deeply they nest, refuses new ones while it is active, and stops the ones that ignore the checkpoint request.
- **Easy control.** `/eta` with autocomplete for `pause`, `resume`, `bypass`, `override` and `guard on`.

Full guide: [mods/usage-eta](mods/usage-eta/README.md).

## How it fits together

```
claude-armory/
├── .claude-plugin/
│   └── marketplace.json     the catalog Claude Code reads
└── mods/
    └── <extension>/
        ├── .claude-plugin/plugin.json
        ├── hooks/           mods and hooks
        ├── skills/          skills
        └── README.md        the extension's own guide
```

The marketplace lists each extension and where it lives. Installing one copies only that extension, so you never pay for the ones you do not use.

## Requirements

- Claude Code with plugin support (desktop app or CLI).
- Python 3 for the setup scripts some extensions ship (standard library only).

## Contributing

Ideas, bug reports and pull requests are welcome.

1. Open an issue describing the problem or the extension you would like.
2. Put a new extension in `mods/<name>/` with its own `.claude-plugin/plugin.json` and a `README.md`.
3. Add it to [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).
4. Include tests, and make sure they pass before you open the pull request:

   ```bash
   claude plugin test mods/<name>
   ```

Only finished, documented extensions are accepted into this repository. `master` is protected: work on a branch (or a fork), open a pull request, and the maintainer merges it.

## Project

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Agent guide](AGENTS.md)

## License

[MIT](LICENSE)
