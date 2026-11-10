# Agents

A chat in Tasma runs an AI agent in the folder of a project. The agent is Claude Code.

## Requirements

Tasma runs your own install of Claude Code. Tasma does not include Claude Code, and it stores no credentials.

1. Install Claude Code. See [Set up Claude Code](https://code.claude.com/docs/en/setup).
2. In a terminal, run `claude` one time and log in.

## How Tasma finds `claude`

The Tasma daemon starts the agent of each chat. The daemon looks for an executable file named `claude` in the folders of `PATH`:

1. The `PATH` of the daemon. A daemon that the `tasma` command starts from a terminal has the environment of that terminal.
2. If `claude` is not there, the daemon reads the environment of your login shell one time, and looks on the `PATH` of that environment. This is the usual case when Tasma starts from Finder or the Dock: the daemon then has only the `PATH` of macOS, `/usr/bin:/bin:/usr/sbin:/sbin`.

To read the environment, the daemon runs your login shell (`$SHELL`) in your home folder, with these flags:

| Shell | Flags |
|---|---|
| `fish` | `-l -c` |
| `csh`, `tcsh` | `-i -c` |
| `pwsh` | `-Login -Command` |
| All other shells, for example `zsh` and `bash` | `-l -i -c` |

With these flags, most shells read the same init files as in a terminal. These shells are different:

- `csh` and `tcsh` do not start as login shells, so they do not read `/etc/csh.login` and `~/.login`. On macOS, `/etc/csh.login` adds the folders of `/etc/paths`, for example `/usr/local/bin`. Set `PATH` in `~/.tcshrc` or `~/.cshrc`.
- `fish` does not start as an interactive shell, so the parts of `config.fish` inside `if status is-interactive` do not run. Set `PATH` outside these parts.

The read stops after 10 seconds.

The agent gets the full environment in which Tasma found `claude`. Thus the tools of the agent find the same programs as in a terminal.

The daemon keeps that environment until it stops. After you change `PATH` in a shell init file, run `tasma daemon stop`. The next daemon reads the environment again.

## `TASMA_RESOLVING_ENVIRONMENT`

While Tasma reads the environment of your login shell, the variable `TASMA_RESOLVING_ENVIRONMENT` is `1`. An init file can use it to skip slow parts, for example:

```sh
if [ "$TASMA_RESOLVING_ENVIRONMENT" != 1 ]; then
  # Slow parts here.
fi
```

## When the agent runs

- A new chat starts in the Auto permission mode, also when your Claude Code settings set `permissions.defaultMode` to `default`, `manual` or `dontAsk`. Two things change this: a mode that you pick in a chat is the start mode of your next chats, except Bypass permissions, and a `permissions.defaultMode` of `acceptEdits`, `plan` or `bypassPermissions` applies while you have not picked a mode. On a model that does not support Auto, Claude Code uses Accept edits.
- Tasma stops the agent of a chat 10 minutes after its last answer, or 1 hour after it in a step whose owner is `human` or in a chat with no task. Commands that the agent started in the background stop with it. A program that runs as a daemon, for example a Docker container, keeps running.
- Tasma tells Claude to start the description of each command that it runs in the background with a mark: `[job]` for a command that ends by itself, for example tests or a build, and `[service]` for a command that runs until something stops it, for example a dev server. While a `[job]` runs, Tasma does not stop the agent, so that the agent can report the result of the job. After the job ends, the agent gets one more period of 10 minutes, or 1 hour. A `[service]` and a command with no mark stop with the agent.
- A `[job]` keeps the agent for at most 2 hours after the last activity in the chat, and the time that the Mac sleeps does not count. Then the chat fails.
- The next message starts the agent again, and the agent keeps the conversation.
- A stop of the daemon, for example at an update of the app, interrupts a running answer. Send a message to continue.

## Errors

A chat that cannot run its agent, or whose agent Tasma stops after a long job, fails with one of these texts. After you correct the cause, send a message in the chat. Tasma starts the agent again. In a chat with no task, `Start a new chat for this step.` reads `Start a new chat.`, and you start a new chat of the project.

| Text | What to do |
|---|---|
| `Claude Code is not installed` | Install Claude Code. `claude` must be an executable file on the `PATH` that Tasma reads. To see it, run `<shell> <flags> '/usr/bin/which claude'` with the flags of your shell from the table in [How Tasma finds `claude`](#how-tasma-finds-claude), for example `zsh -l -i -c '/usr/bin/which claude'`. Tasma does not find a shell alias or a shell function, for example the alias of an old local install in `~/.claude/local`. |
| `Claude is not logged in. Run "claude /login" in a terminal.` | Run `claude /login` in a terminal, then send a message in the chat. |
| `Tasma could not read the environment of your login shell (<shell>): <cause>` | Make sure that `<shell> <flags> true` ends in less than 10 seconds and asks no questions. Use the flags of your shell from the table in [How Tasma finds `claude`](#how-tasma-finds-claude), for example `zsh -l -i -c true` or `tcsh -i -c true`. Use `TASMA_RESOLVING_ENVIRONMENT` to skip slow parts of your init files. As an alternative, run `tasma daemon stop` and then `tasma daemon start` in a terminal: that daemon has the environment of the terminal. |
| `Claude no longer has the conversation of this chat. Start a new chat for this step.` | Claude Code deletes old conversations: see the setting `cleanupPeriodDays`, 30 days by default. Start a new chat for the step. |
| `The folder of this chat no longer exists: <folder>. Start a new chat for this step.` | The folder of the project moved or was deleted. Start a new chat for the step. The new chat starts in the current folder of the project. |
| `The background command "<name>" ran for 2 hours with no update from the agent, so Tasma stopped the agent. Send a message to continue.` | Find why the command did not end, for example a test that waits for input or a child process that it left running. Then send a message in the chat. |
