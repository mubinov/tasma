# tasma
Local task engine that runs your dev and design workflows with agents

## Install

Tasma is a macOS app for macOS 14.5 or later.

Requires Claude Code, logged in.

1. Download the DMG for your Mac:
   - [Apple Silicon (M1 and later)](https://github.com/mubinov/tasma/releases/latest/download/Tasma-arm64.dmg)
   - [Intel](https://github.com/mubinov/tasma/releases/latest/download/Tasma-x64.dmg)

2. Open the DMG and drag Tasma to Applications.
3. Open Tasma. It links the `tasma` command into `/usr/local/bin`, and macOS
   asks for an administrator password once.

After the first launch, the app shows the setup steps.

All releases: [GitHub Releases](https://github.com/mubinov/tasma/releases).

## Agent skill

Your agent needs the tasma skill to run workflow steps and use the `tasma` CLI.
It works with Claude Code and Codex. Install it once for each machine:

```bash
npx skills add mubinov/tasma-skill -g
```

The setup screen of the app can run this command for you. It installs the skill for Claude Code only.

For other install methods, see [tasma-skill](https://github.com/mubinov/tasma-skill).
