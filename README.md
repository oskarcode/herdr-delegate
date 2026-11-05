# Herdr Delegate

A Pi extension for delegating work to another ready agent in a Herdr workspace. It provides a picker for workspaces, tabs, and agents, then brings the selected agent's marked final response back into the current Pi conversation.

## Requirements

- [Pi](https://github.com/earendil-works/pi) with TypeScript extension support.
- [Herdr](https://herdr.dev/) installed and running.
- Pi running in a Herdr-managed interactive terminal. The extension checks `HERDR_ENV=1` and requires Pi's TUI.

## Install

From a Pi session, install this package:

```text
pi install git:github.com/oskarcode/herdr-delegate
```

Then reload Pi with `/reload` or restart the session.

## Use

Start the picker and enter the task when prompted:

```text
/herdr-delegate
```

Or include the task directly:

```text
/herdr-delegate Review the API changes in the current branch and report actionable findings.
```

The extension lets you choose a workspace, tab, and agent, then shows a confirmation before sending the task. It targets existing agents in `idle` or `done` states; it excludes the current pane and does not offer `working`, `blocked`, or `unknown` agents. It does not create or move workspaces, tabs, or panes.

The extension waits up to ten minutes for the task to settle. When the target agent ends its response with the requested markers, the result is added to the current Pi conversation as a rendered message. Results are limited to 40,000 characters. If the task times out or the marked answer cannot be read, the extension reports that and does not automatically resend the prompt.

## Permissions and behavior

Pi extensions execute with the same operating-system permissions as Pi. Review the source before installing. This extension invokes the Herdr CLI to list workspaces, agents, and tabs, and—only after your confirmation—to prompt and read the selected agent. It stores no credentials and does not access other agents' transcripts during target discovery.

Delegation uses the selected agent's existing conversation. The delegated agent may make changes or run commands according to the task and its own permissions; review its response and work as appropriate.

## License

MIT. See [LICENSE](LICENSE).
