# Security policy

Pnyx is a self-custody wallet and a privacy tool. A defect here can cost someone their funds or
their anonymity, so reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security defect.** Use GitHub's private vulnerability
reporting on this repository (Security tab, "Report a vulnerability"), which opens a channel only the
maintainers can see.

Useful in a report, in rough order of value:

- what an attacker gains, and what they need beforehand (a malicious dApp? a lost device? a network
  position?)
- the smallest reproduction you have, even if it is a description rather than a script
- the commit you looked at
- whether you think it is already exploitable against a published build

You will get an acknowledgement, and an honest answer about whether the finding is being fixed, is
already known, or is accepted as out of scope. Nothing is paid: there is no bounty programme, and
pretending otherwise would be worse than saying so.

## What this project considers in scope

- Anything that moves funds without the holder's review, or that signs bytes other than those shown.
- Anything that links two personas to each other or to an identity, or that reveals a vote.
- Key material leaving the device's secure hardware, or reaching a log, a crash report or the network.
- Recovery and backup: a path that loses a seed, or that lets someone else restore one.
- Transaction review showing something other than what the transaction does.

## What it does not

- Findings against a dependency, upstream, where we only pass the value through. Report those
  upstream; tell us too, so we can pin or work around.
- Anything requiring a rooted or jailbroken device the attacker already controls.
- The dormant Chrome extension under `app/extension/`, which is kept compiling on purpose and ships
  nowhere. See `docs/EXTENSION.md`.
- Missing hardening that costs nothing in practice and nothing is built on, reported without an
  attack. A scanner's output is not a vulnerability report.

## Status of this code

⚠️ **This is pre-release software on a test network.** It has had no external audit. Do not put funds
you care about into a build of it, and treat anything it stores as disposable.
