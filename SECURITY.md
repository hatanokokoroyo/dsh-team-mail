# Security

## What this plugin can do

`dsh-team-mail` gives an Agent read and **send** access to a mailbox you
configure. Treat that as a powerful grant:

- Mail bodies and attachments are untrusted data. The plugin's prompt tells the
  Agent not to follow instructions found in mail, but prompt injection is never
  fully solved. Review before installing for a shared or production mailbox.
- Sending only happens when the user explicitly asks; replies are drafted
  first. There is no auto-reply or auto-forward path.

## Where secrets live

- Configuration (account, servers, signature, prompt text) is stored in the
  active DSH profile's `cordis.patch.yml` on your machine.
- The mailbox password is stored in the local DSH credential store
  (`~/.dsh/.credentials.yaml`, mode 0600) or read from the environment variable
  `DSH_TEAM_MAIL_PASS`. It is never part of the repository or the email cache.
- The plugin makes no outbound telemetry requests.

## Reporting a vulnerability

Open a private security advisory on GitHub, or email the maintainer listed in
`package.json`. Please do not file a public issue for anything that could leak
credentials or mail contents.
