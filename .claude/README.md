# Claude Code Configuration

This directory contains Claude Code configuration for the OrianBuilder project.

## Skills

Skills are invoked with `/orianbuilder:<skill>`. Available skills:

| Skill                                      | Description                                                    | Uses                                |
| ------------------------------------------ | -------------------------------------------------------------- | ----------------------------------- |
| `/orianbuilder:plan-to-issue`              | Convert a plan to a GitHub issue                               | -                                   |
| `/orianbuilder:fix-issue`                  | Fix a GitHub issue                                             | `pr-push`                           |
| `/orianbuilder:pr-fix`                     | Fix PR issues from CI failures or review comments              | `pr-fix:comments`, `pr-fix:actions` |
| `/orianbuilder:pr-fix:comments`            | Address unresolved PR review comments                          | `lint`, `pr-push`                   |
| `/orianbuilder:pr-fix:actions`             | Fix failing CI checks and GitHub Actions                       | `e2e-rebase`, `pr-push`             |
| `/orianbuilder:pr-rebase`                  | Rebase the current branch                                      | `pr-push`                           |
| `/orianbuilder:pr-push`                    | Push changes and create/update a PR                            | `remember-learnings`                |
| `/orianbuilder:fast-push`                  | Fast push via haiku sub-agent                                  | -                                   |
| `/orianbuilder:lint`                       | Run all pre-commit checks (formatting, linting, type-checking) | -                                   |
| `/orianbuilder:e2e-rebase`                 | Rebase E2E test snapshots                                      | -                                   |
| `/orianbuilder:deflake-e2e`                | Deflake flaky E2E tests                                        | -                                   |
| `/orianbuilder:deflake-e2e-recent-commits` | Gather flaky tests from recent CI runs and deflake them        | `deflake-e2e`, `pr-push`            |
| `/orianbuilder:session-debug`              | Debug session issues                                           | -                                   |
| `/orianbuilder:pr-screencast`              | Record visual demo of PR feature                               | -                                   |
| `/orianbuilder:feedback-to-issues`         | Turn customer feedback into GitHub issues                      | -                                   |
| `/orianbuilder:promote-beta-to-stable`     | Promote latest pre-release to stable release                   | -                                   |
| `/remember-learnings`                      | Capture session learnings into AGENTS.md/rules                 | -                                   |
