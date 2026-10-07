# Security policy

## What this tool is

DesignLayer is a development tool. It starts a loopback proxy in front of
your dev server and writes edits back into your component source, which means
it has write access to the project it is pointed at. It is not hardened for
any other use, and it should never run in production, in CI against real
source, or on a shared or public-facing machine.

The design it does defend, described in more detail under "Security model" in
the [README](README.md):

- every route refuses a request that is not loopback — checked by peer address,
  `Host`, and `Origin`;
- both servers are forced to bind `127.0.0.1`, overriding the vendored CLI,
  which binds every interface;
- the file allowlist is the only thing between the browser and the rest of your
  project root, `.env.local` included. Keep `source.extensions` restrictive.

A report that one of those three has a hole is a security report. A report that
the tool can edit files in a project you deliberately pointed it at is not — it
is the feature.

## Supported versions

The project is pre-1.0 and moves on `main`. Fixes land there, and there are no
backported release branches. Please confirm a problem against current `main`
before reporting it.

## Reporting a vulnerability

Report privately, not in a public issue.

Use GitHub's private reporting — **Security → Advisories → Report a
vulnerability** on
<https://github.com/phil8-li/design-layer/security/advisories/new>. That opens
a channel only the maintainers can read, and it lets a fix and an advisory ship
together.

Helpful to include:

- what an attacker can reach, and from where — another process on the machine,
  another origin in the browser, a page the proxied app loaded;
- the steps to reproduce, and the version or commit you saw it on;
- your platform and Node version.

Expect an acknowledgement within about a week. This is a small project without
a paid security team or a bounty; what you get is a real answer, credit in the
advisory if you want it, and a fix on `main`.

Please give a fix a reasonable window before publishing, and do not test
against machines or projects that are not yours.
