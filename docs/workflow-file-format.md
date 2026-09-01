# Workflow file format

This document defines the workflow file format. It is written for anyone who
wants to read or write workflow files with their own tools, in any language. It
describes the files on disk. It does not describe how any program is built.

A workflow says which steps a task can be on, and which document a reader must
read for each of them. It says nothing about when a task moves from one step to
the next. That is the subject of a later document.

## 1. Overview

A workflow is a directory. The directory holds one file named `workflow.yml`,
and it may hold the step documents beside it.

```
~/.tasma/
  config.yml
  workflows/
    dev/
      workflow.yml
      steps/
        research.md
        implement.md
    design/
      workflow.yml
  projects/
    TASM/
      config.yml
      state.yml
      tasks/
```

**The tree above shows the default place.** `workflows/` beside `projects/` is
where a reader looks when nothing names another directory. The user's `config.yml`
can name one, which is what lets the workflows of a machine stand in a git
repository. Section 7 states the key.

Workflows are central. One definition is shared by every project that selects
it. A project selects the workflows its tasks may name; it does not copy them and
it does not change them.

A workflow file is a UTF-8 text file. It is read and never written: nothing in
this format is produced by a program, so this document states reader rules alone.

## 2. The workflow directory

**The name of the directory is the name of the workflow.** The directory `dev/`
holds workflow `dev`. `workflow.yml` carries no name key, so the two cannot
disagree.

**A workflow name is 1 to 255 characters from `a-z`, `0-9`, `-` and `_`, and the
first and last character is a letter or a digit.** A name of any other form names
no workflow. This is narrower than the rule for a step name in section 4, because
the name becomes a directory name: it carries no dot and no path separator, it
cannot be `.` or `..`, and it stays within the length one path component holds.
That is what keeps a workflow inside the workflows directory.

A directory whose name breaks the rule, and a directory that holds no
`workflow.yml`, are reported and left out of the list of workflows. A listing
does not fail because one workflow of many is broken, and it does not open any
`workflow.yml`, so a workflow whose file is invalid is still listed.

## 3. `workflow.yml`

The file is a YAML 1.2 mapping.

```yaml
# The reference workflow. Every rule of the format applies to it.
title: Engineering task flow
instructions:
  - common.md
  - ~/notes/house-rules.md
steps:
  - {name: "dev:research", file: steps/research.md, owner: agent}
  - {name: "dev:implement", file: steps/implement.md}
  - {name: "user:review", file: /srv/flows/shared/user-review.md}
transitions:
  "dev:research": [{to: "dev:implement"}]
  "dev:implement": [{to: "user:review"}]
```

| Key | Required | Type | Read |
|---|---|---|---|
| `title` | no | string | Yes, for display. |
| `steps` | yes | list of mappings | Yes. The ordered list of steps, and the set a task's `step` is checked against. |
| `instructions` | no | list of strings | Yes, as paths. |
| `transitions` | no | any | No. The value is stored and handed on unchanged. |

`title` and `instructions` written with no value are read as absent: `title:` on
its own is a file with no title. `transitions` is not read at all, so a reader
hands on whatever the file held, including nothing.

### `steps`

`steps` is a non-empty list of mappings. Each mapping carries `name` and `file`,
both required strings. An entry states identity and location, and nothing else.

The order of the list is the order of the steps.

A key an entry states that this format does not define is kept. The entry is the
one reserved place for a per-step property another component needs.

### `transitions`

`transitions` is reserved. A reader stores the value exactly as it read it and
checks nothing inside it: not that an entry is a mapping, and not that a step
name it holds resolves. The value in the example above is an illustration of a
possible shape, not part of this contract.

### Value limits

Every value in the file passes the same walk a task file's values pass:

- No `__proto__`, `constructor` or `prototype` key at any depth.
- No value that contains itself.
- No value that a YAML tag resolves to a shape other than a scalar, a list or a
  mapping, such as `!!omap` or `!!set`.

YAML anchors and aliases let a small file expand into a very large value. A
reader sets its own bound on how deep a value may nest and on how many values one
key expands to, and rejects a file that goes past the bound instead of failing in
an uncontrolled way. This document fixes no number. The bound belongs to the
reader, as it does in [Task file format](task-file-format.md).

`transitions` is handed to another component, so it takes the same walk as the
rest of the file.

## 4. Step names

**A step name is one or more characters from `a-z`, `0-9`, `-`, `_` and `:`, and
the first and last character is a letter or a digit.**

The rule is wider than the rule for a workflow name in section 2, because a step
name is never a directory name. It allows the colon a flow puts in front of a
step, as in `dev:research`.

Two rules deserve a note:

- **Lowercase only.** A name is matched exactly. Unlike a status or a priority, a
  step name is not a display string the user declares in any casing, so `Research`
  is not `research`.
- **No separator at either end.** `step: dev:` in a task file is a YAML mapping,
  not the string `dev:`, so a name that ends in a colon cannot be written bare.

**The prefix is part of the name.** `dev:research` is one opaque string. This
format does not split it, name its parts, or define a role.

No two steps of one workflow carry the same name.

## 5. Paths

A path resolves against the directory that holds the file which states it.

| Path | Resolves against |
|---|---|
| `steps[].file` in `workflow.yml` | the directory of the workflow |
| `instructions[]` in `workflow.yml` | the directory of the workflow |
| `instructions[]` in a project's `config.yml` | the directory of the project |
| `workflows_path` in the user's `config.yml` | the directory of that file |

An absolute path and a path that starts with `~/` are each accepted and stand for
themselves.

**A path may point anywhere.** A symbolic link is followed, and there is no rule
that a document must stay inside `~/.tasma`. This is what lets step documents live
in a git repository outside the tree.

**A path is resolved lexically.** A reader does not call `realpath`, so a `../`
path stated inside a `workflow.yml` that stands in a symbolically linked workflow
directory walks the path of the link, not the path the link points at. Naming the
real directory with `workflows_path` keeps the case from arising rather than
resolving it.

**A reader does not open the step documents when it loads `workflow.yml`.** It
resolves their paths and stops. A file that is missing or unreadable is reported
when its text is asked for.

## 6. Instruction documents

Three kinds of document, and one rule for all three: **UTF-8 text, never parsed.
The whole file is the instruction text.**

| Document | Declared in | Applies to |
|---|---|---|
| The file of one step | `steps[].file` in `workflow.yml` | that one step |
| Workflow instructions | `instructions` in `workflow.yml` | every step of that workflow |
| Project instructions | `instructions` in the project's `config.yml` | every task of that project |

There is no frontmatter, no heading, no section and no size limit. Line endings
are returned as they stand and nothing is normalized. An empty file is valid.

**The order is part of this contract.** For one step the documents are, in order:

1. the instructions of the workflow,
2. the instructions of the project,
3. the file of the step.

Broad to narrow. Without a stated order two readers would assemble the same rules
differently and behave differently on the same files.

**A reader returns a list, never one joined text.** Each document carries its path
and its text, so a reader can say which document a rule came from.

**Failure is split by what was asked for.** The text of a step is the thing the
caller asked for, so a file that is missing or unreadable refuses the call. An
instructions list is several documents, so one entry that cannot be read is
reported by path and the other documents are still returned.

## 7. The user side

The user's `config.yml` carries one key for workflows. It is a user-level key.
A project's `config.yml` does not recognize it.

| Key | Required | Type | Meaning |
|---|---|---|---|
| `workflows_path` | no | string | The directory the workflows of this machine stand in. |

```yaml
workflows_path: ~/Projects/flows/workflows
```

**The default is `workflows/` beside `projects/` under the root.** A file that
states no `workflows_path` leaves a reader on it.

**The value is one directory, never a list.** Two directories declaring the same
workflow name would need a collision rule, and this format states none. One
workflow that stands elsewhere is reached through a symbolic link inside the
directory: a link is followed, and the name of the link is the name of the
workflow.

**The value must not be empty.** The empty string is refused rather than resolved
to the directory that holds the file.

**The key is user-level alone.** The workflows tree is one shared thing per
machine. A project's `config.yml` that states the key is reported as an unknown
key and the value is not read. A project already chooses which workflows its
tasks may name, through `workflows` in section 8.

Because the key stands at one level, a reader looking for the workflows
directory of a task it reads consults the user's `config.yml` and no other file.
A project's `config.yml` that cannot be read leaves the directory where the user
named it.

**The directory holds workflow directories and nothing else.** Section 2 applies
to it unchanged, so a directory that is no workflow is reported. The scripts and
the shared documents a flow refers to therefore stand outside it, and are reached
by the paths in section 5.

## 8. The project side

A project's `config.yml` carries two keys for workflows. Both are project-level
keys. The user-level `config.yml` recognizes neither.

| Key | Required | Type | Meaning |
|---|---|---|---|
| `workflows` | no | list of strings | The workflows a task of this project may name. |
| `instructions` | no | list of strings | The documents that apply to every task of this project. |

```yaml
name: Tasma
workflows: [dev, design]
instructions:
  - house-rules.md
```

**An empty list is valid and means what an absent key means.** `workflows: []` is
a project that runs no workflow, which is what every project looks like before
one is selected. This is unlike `statuses` and `priorities`, where an empty list
is refused because it would leave no value any write could pass.

**A project runs every step its workflow declares.** There is no per-project
subset of the steps.

## 9. A task's `workflow` and `step`

A task file carries two optional keys, defined in
[Task file format](task-file-format.md):

- `workflow` names the workflow the task runs.
- `step` names the step of that workflow the task is on.

A write refuses a value that does not fit. A read refuses nothing and reports
what does not fit.

### On a write

| The write states | Result |
|---|---|
| `workflow` the project declares, whose directory holds a workflow that loads | accepted |
| `workflow` the project does not declare | refused |
| `workflow` the project declares but whose directory is missing | refused |
| `workflow` of a form the name rule rejects | refused |
| `workflow` whose directory is present but whose file does not load | refused |
| `step` the effective workflow declares | accepted |
| `step` the effective workflow does not declare | refused |
| `step` when no workflow is in effect | refused |
| `step` cleared | accepted |
| `workflow` changed or cleared while a stored `step` no longer fits | accepted, and reported |

**The effective workflow** is the value of `workflow` after the change is applied.
A write usually states `step` alone, so `step` is checked against the stored
`workflow` as well as against a stated one.

**A task with no workflow may not carry a step.** No workflow means an empty set
of steps, so every step value is invalid. On a create nothing is stored yet, so a
`step` with no `workflow` in the same call is refused.

**A mismatch that already exists in a file is always reported, never refused.**
Only the value being written is refused. Removing a step from a workflow leaves
the tasks that sit on it as they are: they are reported, and they stay readable
and writable.

**A stored `workflow` is not re-checked against the project's list.** The list
states what may be written. A project that drops a workflow leaves the tasks that
name it alone.

### On a read

A read reports two things about a task, and refuses neither:

- The task names a workflow that does not exist or does not load.
- The task carries a `step` that its workflow does not declare, **or carries a
  `step` and no `workflow` at all.**

The second case matters. A write is allowed to clear `workflow` while a `step`
remains, and that combination is invalid, so a read has to name it.

A read does not consult the list of workflows the project declares. That check is
for a write.

## 10. Malformed files

Two behaviors are defined, as in [Task file format](task-file-format.md):

- **Reject.** The workflow does not load.
- **Warn.** The workflow loads unchanged, and the reader names the fault.

### A reader must reject

| Condition |
|---|
| The workflow directory exists, and `workflow.yml` cannot be opened or read. |
| `workflow.yml` is not valid YAML. |
| `workflow.yml` is not a mapping. |
| `steps` is missing, is not a list, or is empty. |
| A step entry is not a mapping. |
| A step entry has no `name`, or holds `name` as a value that is not a string. |
| A step entry has no `file`, or holds `file` as a value that is not a string. |
| A step name breaks the rule in section 4. |
| Two step entries carry the same name. |
| `title` is present and is not a string. |
| `instructions` is present and is not a list of strings. |
| Any value in the file breaks a limit in section 3. |

A reader that rejects names the file, and the line where the YAML parser reports
one.

### A reader must warn

| Condition |
|---|
| An unknown top-level key in `workflow.yml`. The rest of the file loads, and the value of that key is not read. This is what catches a misspelling. |
| A directory in the workflows directory that holds no `workflow.yml`, or whose name breaks the rule in section 2. It is left out of the list. |
| A task names a workflow that does not exist or does not load. |
| A task carries a step its workflow does not declare, or carries a step and no workflow. |
| One entry of an `instructions` list cannot be read. The other documents are still returned. |
| The workflows directory itself cannot be used, under the rule below. The list is empty and the fault is named. |
| A reader cannot resolve the user's `config.yml` while it reads a task. It uses the default workflows directory and names the fault, rather than refusing the read. |

The last row keeps one broken `config.yml` from making every task of a project
unreadable. A write is not covered by it: a write validates against the lists the
user declared, and guessing at those is not acceptable.

### A directory that cannot be used

One rule covers the workflows directory itself:

> The only silent case is the built-in default that does not exist.

| The workflows directory | Missing | Anything else — not a directory, no permission, and so on |
|---|---|---|
| the default under the root | silent, empty list | reported, empty list |
| the one `workflows_path` names | reported, empty list | reported, empty list |

A missing default is a tree that holds no workflow, the way a project with no
task files holds no task. A directory the user named is reported when it is not
there, because the user wrote the name and a listing that answers nothing has to
say why.

A listing never fails on the directory itself. It answers the empty list and
names the fault. Reading one workflow by name is a different question: a name
that reaches no directory is a workflow that does not exist, which section 9
states for the task that names one.
