# Setup — the `dev:setup` step

Make the branch `<TAG>-<n>` in each repo of Repos touched. The step changes nothing else.

## Check every repo first

Check every repo before the first branch, so that a stop does not leave only some repos branched:

```
git -C <repo> branch --show-current
git -C <repo> status --short
git -C <repo> show-ref --verify --quiet refs/heads/<TAG>-<n>
```

The first row that matches decides the action:

| What the check shows | Action |
|---|---|
| The path is not a git repo | Stop and ask the user |
| The repo is on `<TAG>-<n>` (a second run of the step) | Nothing to do |
| `<TAG>-<n>` exists, but another branch is checked out | Stop and ask the user |
| No branch is checked out (detached HEAD) | Stop and ask the user |
| The repo is on another `<TAG>-*` branch | Stop and ask the user |
| Uncommitted changes outside `.specs/` | Stop and ask the user |
| None of these | `git -C <repo> checkout -b <TAG>-<n>` |

- "Stop and ask the user" names the repo and what the check showed. No repo gets a branch until the user answers. The answer of the user decides what the step does for that repo. When the answer ends the step, the hand-off is `# Stopped: dev:setup`, with no next chat, and the step stays `dev:setup`.
- The reason for the checks: a new branch takes the uncommitted changes with it, and those changes can be the work of another task.
- The branch starts at the current commit. The step does not fetch or pull: the user chooses the state of the repos before they start this step.

## End of the step

Add a comment `dev:setup` with each repo and its branch and, for each stop, a quote of the answer of the user. Set `dev:implement` and start its chat.
