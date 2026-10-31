# The engineering flow

The **tasma skill** holds the commands, the comment protocol and the rules to create, split and skip tasks. This document holds the flow, its gates and its conventions.

## State lives on the step, not on the status

The step tells where the task is in the flow. The status stays coarse: on each step it is the work-in-progress status of the project. Name a status by its role, as the skill does, never by a fixed name.

The [State → Action](#state--action) table tells what each step does and where it routes.

## Layout

Find the layout from the project folder, the folder of the Tasma project:

- **Single repo.** `git -C <project folder> rev-parse --show-toplevel` succeeds. That repository is the one repo of the project.
- **Multi-repo workspace.** The project folder is not inside a git repository. Each direct subfolder that is a git repository is a repo of the project.

Where a step says "each repo of Repos touched", a single-repo project reads it as its one repo.

## Branch and task

- The branch name is `<TAG>-<n>`, the same in each repo.
- The **Repos touched** list of the spec decides which repos get the branch. The other repos stay as they are.
- Branches are made at `dev:setup` (and see rule 1 of [Git](#git)), never during research.
- Each git command names its repo: `git -C <repo> …`. A command in the wrong folder works on the wrong repo.

## Find the task in a workspace

The task-finding procedure of the skill applies. This flow adds the case of a multi-repo workspace, where the project folder is not a repository. Run `git -C <repo> branch --show-current` in each repo:

- One id `<TAG>-<n>`, in one repo or more → that is the task.
- Different ids → stop and ask the user. Do not guess.
- No `<TAG>-*` in any repo → a flow that touches no repo makes no branch, so list the tasks with the work-in-progress status. A task on a step of such a flow is the task. Still nothing → find the task as the skill says, and create no branch: `dev:setup` does that later.

With the task found, read its step and do its row of the [State → Action](#state--action) table.

## The spec file

- During research the spec is a local file, `<project folder>/.specs/<TAG>-<n>.md`. The user can read it against the code, and the independent review can read it.
- Before the research step writes a new file in `.specs/` (the spec, the split plan or a page):
  - When `.specs/` does not exist, the step creates it and writes `.specs/.gitignore` with the one line `*`.
  - When `.specs/` exists already inside a repository, the step runs `git -C <project folder> check-ignore -q <path of the file>`. When the file is not ignored, the step still writes it. It tells the user which files show in `git status`, and it adds or changes no ignore rule without the user's approval.
- After approval the spec is copied into the task body, which is then the source of truth. Keep the local file in sync with it.

## Human checkpoints are conversations

At a review gate, show the work in the chat, tell where it is, and wait. The user reads, asks questions, pushes back or asks for changes in their own words. The agent answers and revises until the user explicitly says that the work is approved.

Never drive a review gate with a blocking prompt of fixed answers, for example a question tool of the agent with "Approve / Changes needed". It forces a choice before the user has examined the work. Approval is explicit and can be quoted, never inferred.

A closed-form prompt is allowed to narrow the scope during research, and at an action step, where nothing is under review and the approval happened at an earlier gate.

## Human gates

This is the full list. All are review gates unless named otherwise.

- **During `dev:research`.** The agent cannot write a spec from a bare title. It works with the user, and the step ends with an independent review before the user sees the spec.
- **Spec approval.** Nothing goes into the task without the user's approval. The approval ends research. This gate is inside `dev:research`: the step cannot finish itself.
- **`user:review`.** The user reviews and tests by hand.
- **Inside `dev:integrate`.** The user approves the commit split before the first commit. It is a pause, not a hand-off: the same chat continues when the user answers.

`dev:review` is not a human gate: its pass or fail is the agent's judgment.

## State → Action

| The step | What the agent does | On success → | On failure → |
|---|---|---|---|
| `dev:research` | Turn the task into an approved spec, read-only, **creating no branch**. The step has two exits, defined in its document | **Spec exit**: on the user's approval, save the spec into the task body, set `dev:setup`, and **do not start the next chat**. **Decomposition exit**: on the user's approval, save the split plan into the body, create the children, clear the step, set a final status | — |
| `dev:setup` | Create the `<TAG>-<n>` branch in each repo of the spec's **Repos touched** | `dev:implement` | — |
| `dev:implement` | Implement the approved spec, or handle the findings that sent the task back | `dev:review` | — |
| `dev:review` | Review the diff and route it | `## Review #N: PASS` note → `dev:test` | `## Review #N: FAIL` note that lists every finding → `dev:implement` |
| `dev:test` | Check the function, run and fix the tests, remove the files that the test run made | `user:review` | `dev:implement` + a comment on the task |
| `user:review` | Stop. Brief the user, and let the user review and test by hand | (the user approves) `dev:integrate` | (the user writes the problem in the chat) `dev:implement` + a comment on the task |
| `dev:integrate` | Commit, push the task branch, open the pull request, post the release checklist | (every repo landed, checklist posted) set a final status | (something is unclear) the step stays at `dev:integrate`, and the user handles that repo by hand |

## Next chat: the flow's own rules

Two rules of this flow stop the start of the next chat:

- **Never start the `dev:setup` chat.** Research is read-only and can run while another task is active on its `<TAG>-*` branches, and `dev:setup` creates branches. A branch made on top of the checked-out work of another task damages that work. The user decides when development starts and on which state of the repos.
- **Review loop limit.** A FAIL on review 15 or later stops for the user, so that the loop cannot run without end. The review step states what that hand-off contains.

## Communication between chats

This flow adds four rules to the comment protocol of the skill:

- **`Dev notes:` for each deviation from the spec.** The review step sees only the approved spec and the diff. Each place where the code differs from the spec (a repo that is not in the list, a "do not touch X" that had to change, a different approach) must be a `Dev notes:` comment that tells what changed and why. Then the reviewer judges the decision and does not report a defect. Keep the local spec file in sync.
- **A failed review routes as well as reports.** Its verdict comment lists the blocking findings, and the step goes back to `dev:implement`. That comment is the only context that the next chat gets.
- **The spec is a local file during research.** See [The spec file](#the-spec-file).
- **Each spec has Repos touched and Release & smoke check.**
  - **Repos touched** is the list of repos that get a `<TAG>-<n>` branch at `dev:setup`. A repo found missing later is a gap in the spec: branch it and record a `Dev notes:` deviation.
  - **Release & smoke check** is the release plan and 2 to 4 smoke checks, written during research. `dev:integrate` turns it into the posted checklist, and the user runs it.

## Hand-off headers

The skill's procedure to end a step applies. This flow sets the headers:

- The first header is `# ✅ Done: <from-step> → <to-step>`.
- The block of user actions is `# REQUIRED FROM USER`. A note "for your information" or "for the reviewer" is not an action and does not go in that block.

## Git

`dev:research` and `dev:review` are read-only steps.

1. `dev:setup` creates and checks out `<TAG>-<n>` in each repo of Repos touched. `dev:implement` does the same only for a repo that Repos touched missed, and records it in `Dev notes:`.
2. Commits happen only at `dev:integrate`, by the approved split. Until then the work of the task is only in the working tree. So before `dev:integrate`:
   - no step commits, because a commit goes around the split;
   - no step discards or hides changes (`checkout -- <path>`, `restore`, `reset`, `stash`, `clean`), because that loses the work of the task.
3. `dev:integrate` rebases the task branch onto the base branch only when the user chose it, and only while the task branch is not on the remote. It pushes only the task branch, only to the remote of the base branch, never to a remote that it guesses. It opens the pull request.
4. The flow never merges, never pushes the base branch and never force-pushes. The user merges the pull request.

## Model levels of review subagents

A review subagent runs at the level that its step names. Only review subagents have a level.

- **Top level**: a strong model, for example Opus level. Not a more expensive model above it, for example Fable level.
- **Standard level**: a faster model, for example Sonnet level.

When the agent cannot choose the model of a subagent, the subagent uses the default model of the agent.
