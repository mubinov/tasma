# tasma CLI

Command form: `tasma [global options] <group> <command> [arguments] [options]`.

tasma keeps its data in one directory, `$HOME/.tasma`: the projects, their tasks and, by default, the workflows. One daemon serves this directory.

Global options go before `<group>`. `tasma <group> --help` lists the commands of a group. `tasma <group> <command> --help` lists the options of a command.

## Global options

| Option | Meaning |
|---|---|
| `-h`, `--help` | Print the help. |
| `-v`, `--version` | Print the version. |
| `--daemon <url>` | The daemon address. It must be `http:` on `127.0.0.1`, `[::1]` or `localhost`. |

## Environment

| Variable | Meaning |
|---|---|
| `TASMA_DAEMON_URL` | The daemon address when `--daemon` is not given. |
| `HOME` | The data directory is `$HOME/.tasma`. |

When no address is given, tasma reads `$HOME/.tasma/daemon.json`. If that file is missing or not valid, it uses `http://127.0.0.1:8278`. If no daemon answers there, the command starts one. `daemon status` and `daemon stop` never start a daemon. tasma never starts a daemon at an address given by `--daemon` or `TASMA_DAEMON_URL`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | The daemon refused the request, or `project current` found no project. |
| 2 | Usage error: bad arguments, flags or daemon address, or no project holds the working directory. |
| 3 | No usable answer from the daemon, or the daemon could not be started or stopped. |

## Shared rules

**Project.** `task list` and `task create` act on the project that `-p, --project <tag>` names. An empty tag is an error. Without this flag, tasma asks the daemon which project holds the working directory and writes `tasma: project <tag>, from <dir>` to stderr. If no project holds the directory, the command fails with exit code 2.

**Values.** A value that starts with `-` must be written as `--<flag>=<value>`, for example `--order=-1`. The value `-` alone is not affected. In a command that writes, a flag with an empty value is an error.

**Body.** A command with a body reads it from `--body <text>` or `--body-file <path>`, never from both. `--body-file -` reads standard input. The file content is used as it is: an empty file is an empty body.

**Edit.** An edit command changes only the fields its flags give. It needs at least one change.
- To remove a field, use `--clear <field>`, one time for each field. You cannot use `--clear` and a flag for the same field together.
- `--append` adds the new body after the stored body, with one empty line between them. It needs `--body` or `--body-file`. The read and the write are two requests: a change made between them is lost.

**Output.** stdout carries the result: a table, a text, the id or tag that a write command changed, or the line of a `daemon` command. The help and the version also go to stdout. Tables have no header row, columns are separated by 2 or more spaces, and `-` marks an empty value. Notes and errors go to stderr, and each note and error line starts with `tasma:`.

## project

A tag is 2 to 8 characters: an uppercase letter, then uppercase letters or digits.

### `tasma project list`

List all projects. Columns: tag, name, path.

### `tasma project view <tag>`

Print the configuration of one project as key and value rows: `tag`, `name`, `path`, `statuses`, `default_status`, `final_statuses`, `priorities`, `workflows`, `instructions`, `workflows_path`. A list value continues on the next rows, with an empty key.

### `tasma project current`

Print the tag of the project that holds the working directory.

### `tasma project create --path <path> [--name <name>] [--tag <tag>]`

Create a project for a folder. A relative `--path` starts at the working directory, and `~/` starts at the home directory. `--name` is the folder name when not given. `--tag` is made from the folder name when not given. Prints the tag.

### `tasma project edit <tag> [--path <path>] [--name <name>] [--clear name]`

Change the path or the name of a project. `--path` is read as in `project create`. Prints the tag.

### `tasma project rename <old> <new>`

Change the tag of a project and of all its tasks. Prints the new tag.

### `tasma project delete <tag>`

Remove a project and all its tasks. The folder at the path of the project does not change. The command does not ask for confirmation. Prints the removed tag.

## task

A task id is `<tag>-<number>`, for example `TASM-12`. The part before the `-` is the project tag.

### `tasma task list [options]`

List the tasks of a project. Columns: id, status, priority, step, title. A filter with an empty value is not applied. For each file that the daemon cannot read as a task, a `tasma: excluded:` line goes to stderr.

- `-p, --project <tag>`: the project. See **Project** in Shared rules.
- `--status <s>`, `--priority <p>`, `--parent <id>`, `--step <s>`: only the tasks with this value.
- `--label <l>`: only the tasks that have all the given labels. Repeat the flag for each label.
- `--blocked` or `--unblocked`: only the tasks with an open blocker, or only the tasks with no open blocker. A blocker is open while its status is not in the `final_statuses` of the project, or when its id names no task of the project.

### `tasma task view <id> [--full]`

Print the text of one task. The bodies of collapsed comments are not included, and stderr lists their comment ids. `--full` prints the complete file.

### `tasma task create --title <title> [options]`

Create a task. Prints the new task id.

- `-p, --project <tag>`: the project. See **Project** in Shared rules.
- `--status <s>`: the status. The default is the `default_status` of the project.
- `--priority <p>`, `--step <s>`, `--workflow <w>`: the value of the field.
- `--parent <id>`: the task this task is under.
- `--label <l>`, `--blocked-by <id>`: one label or one blocker. Repeat the flag for each value.
- `--order <n>`: an integer, the position in the status.
- `--body <text>`, `--body-file <path>`: the body.

### `tasma task edit <id> [options]`

Change the fields or the body of a task. Prints the id.

- The field and body flags of `task create`, without `-p`. `--label` and `--blocked-by` replace the stored list.
- `--append`: add the body after the stored body.
- `--clear <field>`: remove `priority`, `labels`, `parent`, `blocked_by`, `step`, `workflow`, `order` or `body`.

### `tasma task delete <id>`

Remove a task. Prints the id.

## comment

A comment is named by its task id and its comment id `<n>`, a whole number.

### `tasma comment list <task-id>`

List the comments of a task. Columns: id, line range in the task file, body size in bytes, `collapsed` or `-`, created, author, title.

### `tasma comment view <task-id> <n>`

Print the text of one comment, with its marker.

### `tasma comment add <task-id> --title <title> [options]`

Add a comment to a task. Prints the new comment id.

- `--author <name>`: who wrote the comment.
- `--collapsed`: store the comment collapsed. `task view` then shows its title and hides its body.
- `--body <text>`, `--body-file <path>`: the body.

### `tasma comment edit <task-id> <n> [options]`

Change the fields or the body of a comment. Prints the comment id.

- `--title <title>`, `--author <name>`, `--collapsed`, `--body <text>`, `--body-file <path>`: as in `comment add`.
- `--append`: add the body after the stored body.
- `--clear <field>`: remove `author`, `collapsed` or `body`. `--clear collapsed` is the only way to expand a comment.

### `tasma comment delete <task-id> <n>`

Remove a comment. Prints the comment id.

## workflow

Workflows are shared by all projects. A project selects which workflows its tasks can use. `workflows_path` in `$HOME/.tasma/config.yml` can put the workflows in a different folder.

### `tasma workflow list`

List the workflow names, one on each line.

### `tasma workflow show <name>`

Print one workflow as blocks with an empty line between them: the name and title, one `instructions <path>` row for each instruction document, and one `<step> <owner> <file>` row for each step. The owner is `agent` or `human`. A block with no rows is left out.

## daemon

`daemon start` and `daemon stop` act only on the daemon of `$HOME/.tasma`. They refuse `--daemon` and `TASMA_DAEMON_URL`.

### `tasma daemon start`

Start the daemon if none answers. Prints `tasma-daemon <version> at <url>`.

### `tasma daemon status`

Print `tasma-daemon <version> at <url>`. If no daemon answers, the command fails with exit code 3.

### `tasma daemon stop`

Stop the daemon and wait up to 10 seconds. Prints `tasma-daemon at <url> stopped`. If no daemon runs, prints `no daemon is running` and exits with code 0.
