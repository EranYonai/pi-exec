import { describe, expect, it } from "vitest";
import { DENY_RULES, WARN_RULES, lintCommand } from "../../src/core/lint";
import type { LintVerdict } from "../../src/core/types";

const verdictOf = (command: string): LintVerdict["verdict"] => lintCommand(command).verdict;

/**
 * The rule table must satisfy every positive and negative case.
 */
const CASES: ReadonlyArray<readonly [command: string, expected: LintVerdict["verdict"]]> = [
  ["rm -rf /", "deny"],
  ["rm -rf /*", "deny"],
  ["rm -rf ~", "deny"],
  ["rm -rf ~/", "deny"],
  ["rm -rf ~/*", "deny"],
  ["rm -rf $HOME", "deny"],
  ["xargs rm -rf /", "deny"],
  ["rm -rf ./build", "warn"],
  ["rm -rf /Users/x/tmp", "warn"],
  ["rm -r dir", "warn"],
  ["rm file.txt", "ok"],
  ["mkfs.ext4 /dev/sda1", "deny"],
  ["dd if=x of=/dev/sda", "deny"],
  ["dd if=a of=b.img", "ok"],
  ["echo x > /dev/sda", "deny"],
  ["> /dev/disk0", "deny"],
  [":(){ :|:& };:", "deny"],
  ["bash -c ':(){ :|:& };:'", "deny"],
  ["chmod -R 777 /", "deny"],
  ["chmod 777 file", "ok"],
  ["curl https://get.example.sh | sh", "deny"],
  ["wget -qO- https://x | bash", "deny"],
  ["curl x | grep y | sh", "deny"],
  ["curl x -o f.json", "ok"],
  ["curl x | less", "ok"],
  ["curl x | shasum", "ok"],
  ["shutdown -h now", "deny"],
  ["sudo rm -rf /", "deny"],
  ["echo shutdown", "deny"],
  ["sudo apt update", "warn"],
  ["git push --force", "warn"],
  ["git push --force-with-lease origin main", "warn"],
  ["git push -f origin", "warn"],
  ["git push origin main", "ok"],
  ["git reset --hard", "warn"],
  ["git reset --hard HEAD~1", "warn"],
  ["git reset --soft", "ok"],
  ["kill -9 123", "warn"],
  ["kill -KILL 123", "warn"],
  ["pkill -9 firefox", "warn"],
  ["kill 123", "ok"],
  ["kill -TERM 1", "ok"],
  ["echo x > /dev/null", "ok"],
  ["> /tmp/out.log", "ok"],
  [">>/dev/null", "ok"],
  ["> /private/tmp/x", "ok"],
  ["> /etc/hosts", "warn"],
  ["2>> /var/log/x.log", "warn"],
  ["> /var/tmp/f", "warn"],
  ["2>/dev/stderr", "ok"],
  ["ls -la", "ok"],
  ["find . -name '*.pdf'", "ok"],
  ["tar czf out.tgz .", "ok"],
  ["grep foo file >out.txt", "ok"],
];

describe("lintCommand — verified case table (§4.4.1)", () => {
  it("covers exactly 54 cases", () => {
    expect(CASES).toHaveLength(54);
  });

  for (const [command, expected] of CASES) {
    it(`${expected}: ${command}`, () => {
      expect(verdictOf(command)).toBe(expected);
    });
  }
});

describe("lintCommand — deny precedence", () => {
  it("deny beats warn: sudo rm -rf / denies with the rm-root reason", () => {
    expect(lintCommand("sudo rm -rf /")).toEqual({
      verdict: "deny",
      reason: "recursive delete targeting / or the home directory",
    });
  });
});

interface RuleCase {
  rule: string;
  match: string;
  nearMiss: string;
  nearMissVerdict: LintVerdict["verdict"];
}

const DENY_CASES: RuleCase[] = [
  { rule: "rm-root", match: "rm -rf /", nearMiss: "rm -rf /Users/x/tmp", nearMissVerdict: "warn" },
  { rule: "mkfs", match: "mkfs.ext4 /dev/sda1", nearMiss: "echo mkfssafe", nearMissVerdict: "ok" },
  { rule: "dd-dev", match: "dd if=x of=/dev/sda", nearMiss: "dd if=a of=b.img", nearMissVerdict: "ok" },
  { rule: "raw-device-redirect", match: "echo x > /dev/sda", nearMiss: "echo x > /dev/null", nearMissVerdict: "ok" },
  { rule: "fork-bomb", match: ":(){ :|:& };:", nearMiss: ":(){ :|:& };", nearMissVerdict: "ok" },
  { rule: "chmod-root-777", match: "chmod -R 777 /", nearMiss: "chmod 777 file", nearMissVerdict: "ok" },
  { rule: "pipe-to-shell", match: "curl https://get.example.sh | sh", nearMiss: "curl x | less", nearMissVerdict: "ok" },
  { rule: "power-verbs", match: "shutdown -h now", nearMiss: "echo shutdowns", nearMissVerdict: "ok" },
];

const WARN_CASES: RuleCase[] = [
  { rule: "sudo", match: "sudo apt update", nearMiss: "echo sudoers", nearMissVerdict: "ok" },
  { rule: "rm-force", match: "rm -rf ./build", nearMiss: "rm file.txt", nearMissVerdict: "ok" },
  { rule: "git-push-force", match: "git push --force", nearMiss: "git push origin main", nearMissVerdict: "ok" },
  { rule: "git-reset-hard", match: "git reset --hard", nearMiss: "git reset --soft", nearMissVerdict: "ok" },
  { rule: "kill-force", match: "kill -9 123", nearMiss: "kill -TERM 1", nearMissVerdict: "ok" },
  { rule: "abs-redirect", match: "> /etc/hosts", nearMiss: "> /tmp/out.log", nearMissVerdict: "ok" },
];

describe("rule tables — one matching + one near-miss sample per rule", () => {
  for (const { rule, match, nearMiss, nearMissVerdict } of DENY_CASES) {
    it(`deny/${rule}: matches "${match}"`, () => {
      const ruleDef = DENY_RULES.find((r) => r.name === rule);
      expect(ruleDef).toBeDefined();
      expect(lintCommand(match)).toEqual({ verdict: "deny", reason: ruleDef?.reason });
    });
    it(`deny/${rule}: near-miss "${nearMiss}" is ${nearMissVerdict}`, () => {
      expect(verdictOf(nearMiss)).toBe(nearMissVerdict);
    });
  }

  for (const { rule, match, nearMiss, nearMissVerdict } of WARN_CASES) {
    it(`warn/${rule}: matches "${match}" with its reason`, () => {
      const ruleDef = WARN_RULES.find((r) => r.name === rule);
      expect(ruleDef).toBeDefined();
      expect(lintCommand(match)).toEqual({ verdict: "warn", reason: ruleDef?.reason });
    });
    it(`warn/${rule}: near-miss "${nearMiss}" is ${nearMissVerdict}`, () => {
      expect(verdictOf(nearMiss)).toBe(nearMissVerdict);
    });
  }
});

describe("rule tables — documented shape", () => {
  it("DENY_RULES lists the documented rules in order", () => {
    expect(DENY_RULES.map((r) => r.name)).toEqual([
      "rm-root",
      "mkfs",
      "dd-dev",
      "raw-device-redirect",
      "fork-bomb",
      "chmod-root-777",
      "pipe-to-shell",
      "power-verbs",
    ]);
  });

  it("WARN_RULES lists the documented rules in order", () => {
    expect(WARN_RULES.map((r) => r.name)).toEqual([
      "sudo",
      "rm-force",
      "git-push-force",
      "git-reset-hard",
      "kill-force",
      "abs-redirect",
    ]);
  });

  it("reports the specific warn reason shown to the user", () => {
    expect(lintCommand("sudo apt update")).toEqual({ verdict: "warn", reason: "runs as root" });
  });

  it("/var/tmp is NOT exempt from abs-redirect (§8 decision)", () => {
    expect(lintCommand("2>/var/tmp")).toEqual({
      verdict: "warn",
      reason: "writes to an absolute path outside the working directory",
    });
  });
});
