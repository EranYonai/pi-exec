import type { LintRule, LintVerdict } from "./types";

/**
 * Hard-deny rules: the command is never run, not even with --exec-yes.
 * First matching rule wins. Keep each rule's positive and negative tests.
 */
export const DENY_RULES: readonly LintRule[] = [
  {
    name: "rm-root",
    reason: "recursive delete targeting / or the home directory",
    pattern: /\brm\s+(?:-{1,2}[\w-]+\s+){0,3}(?:\/|\$HOME|~)\/?\*?(?:\s|$)/,
  },
  {
    name: "mkfs",
    reason: "filesystem creation destroys the target device",
    pattern: /\bmkfs(?:\.\w+)?\b/,
  },
  {
    name: "dd-dev",
    reason: "dd writing to a raw device",
    pattern: /\bdd\b[^|;&]*\bof=\/dev\//,
  },
  {
    name: "raw-device-redirect",
    reason: "redirect writing to a raw disk device",
    pattern: />{1,2}\s*\/dev\/(?:sd[a-z]|nvme|disk|hd|vd)[a-z0-9]*\b/,
  },
  {
    name: "fork-bomb",
    reason: "fork bomb pattern",
    pattern: /: *\(\) *\{[^}]*\} *; *:/,
  },
  {
    name: "chmod-root-777",
    reason: "recursively chmod 777 on the filesystem root",
    pattern: /\bchmod\s+(?:-{1,2}[\w-]+\s+){0,3}777\s+\/(?:\s|$)/,
  },
  {
    name: "pipe-to-shell",
    reason: "remote script piped straight into a shell",
    pattern: /\b(?:curl|wget)\b[^;&]*\|[^\n]*\b(?:sudo\s+)?(?:ba|z|fi|da|k)?sh\b/,
  },
  // Matches anywhere in the line — a deliberate over-block, documented.
  {
    name: "power-verbs",
    reason: "shutdown/reboot/halt/poweroff (matches anywhere — deliberate over-block, documented)",
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/,
  },
];

/**
 * Soft-warn rules: the command runs only after confirm, and the reason must
 * be shown in the confirm dialog / stdout security banner.
 */
export const WARN_RULES: readonly LintRule[] = [
  {
    name: "sudo",
    reason: "runs as root",
    pattern: /\bsudo\b/,
  },
  {
    name: "rm-force",
    reason: "recursive/forced delete",
    pattern: /\brm\s+(?:-{1,2}[\w-]+\s+){0,3}-{1,2}[\w-]*[rf][\w-]*/,
  },
  {
    name: "git-push-force",
    reason: "force push rewrites remote history",
    pattern: /\bgit\s+push\b[^;&]*(?:--force(?:-with-lease)?\b|-f\b)/,
  },
  {
    name: "git-reset-hard",
    reason: "hard reset discards uncommitted work",
    pattern: /\bgit\s+reset\s+(?:-{1,2}[\w-]+\s+){0,2}--hard\b/,
  },
  {
    name: "kill-force",
    reason: "force-kills processes",
    pattern: /\bp?kill\s+(?:-\w+\s+){0,2}-(?:9|KILL)\b/,
  },
  {
    name: "abs-redirect",
    reason: "writes to an absolute path outside the working directory",
    pattern: />{1,2}\s*\/(?!dev\/(?:null|stdout|stderr|zero)(?:\b|\/)|(?:private\/)?tmp(?:\b|\/))/,
  },
];

/** deny first, then warn, then ok. First matching rule wins per table. */
export function lintCommand(command: string): LintVerdict {
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) return { verdict: "deny", reason: rule.reason };
  }
  for (const rule of WARN_RULES) {
    if (rule.pattern.test(command)) return { verdict: "warn", reason: rule.reason };
  }
  return { verdict: "ok" };
}
