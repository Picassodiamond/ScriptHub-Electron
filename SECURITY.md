# Security

ScriptHub is a **single-user desktop tool with no authentication by design**. It runs scripts you point it at, and
creating or editing scripts in the app is arbitrary code execution as your user. Only open folders and project files
you trust, and treat a downloaded `.scripthub` project like any other program.

The renderer is sandboxed (context isolation, no Node, strict CSP, no network server), and processes are started
without a shell. Passwords entered for a run are never stored.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security tab) instead of a public issue. Include the
version, steps to reproduce and the impact. You will get a reply within a few days.
