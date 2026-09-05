import { describe, expect, it } from "vitest";
import { MAX_COMMAND_LENGTH, parseModelOutput } from "../../src/core/parse";

const EMPTY = { kind: "refusal", reason: "model returned empty output" } as const;

describe("parseModelOutput", () => {
  describe("empty output", () => {
    it('refuses ""', () => {
      expect(parseModelOutput("")).toEqual(EMPTY);
    });

    it("refuses whitespace-only output", () => {
      expect(parseModelOutput("  \n\t  ")).toEqual(EMPTY);
    });
  });

  describe("clean command", () => {
    it("returns the single trimmed line", () => {
      expect(parseModelOutput("  ls -la  ")).toEqual({ kind: "command", command: "ls -la" });
    });
  });

  describe("code fences", () => {
    it("strips a fenced block with a language tag", () => {
      expect(parseModelOutput("```bash\nls -la\n```")).toEqual({
        kind: "command",
        command: "ls -la",
      });
    });

    it("strips a fenced block without a language tag", () => {
      expect(parseModelOutput("```\nls -la\n```")).toEqual({
        kind: "command",
        command: "ls -la",
      });
    });

    it("handles \\r\\n inside a fenced block", () => {
      expect(parseModelOutput("```bash\r\nls -la\r\n```")).toEqual({
        kind: "command",
        command: "ls -la",
      });
    });

    it("strips an inline fence", () => {
      expect(parseModelOutput("```ls -la```")).toEqual({ kind: "command", command: "ls -la" });
    });

    it("unwraps quotes inside a fenced block", () => {
      expect(parseModelOutput('```\n"ls -la"\n```')).toEqual({
        kind: "command",
        command: "ls -la",
      });
    });

    it("trims whitespace inside a fenced block", () => {
      expect(parseModelOutput("```\n  ls -la  \n```")).toEqual({
        kind: "command",
        command: "ls -la",
      });
    });

    it("refuses fence+prose via the line-count rule", () => {
      expect(parseModelOutput("```\nls\n```\nthanks")).toEqual({
        kind: "refusal",
        reason: "expected exactly one command line, got 4",
      });
    });

    it("refuses a lone fence as empty output", () => {
      expect(parseModelOutput("```")).toEqual(EMPTY);
    });
  });

  describe("line count", () => {
    it("refuses two commands", () => {
      expect(parseModelOutput("ls\ngit status")).toEqual({
        kind: "refusal",
        reason: "expected exactly one command line, got 2",
      });
    });

    it("ignores blank lines between commands but still refuses", () => {
      expect(parseModelOutput("ls\n\n\ngit status")).toEqual({
        kind: "refusal",
        reason: "expected exactly one command line, got 2",
      });
    });

    it("refuses two commands separated by \\r\\n", () => {
      expect(parseModelOutput("ls\r\ngit status")).toEqual({
        kind: "refusal",
        reason: "expected exactly one command line, got 2",
      });
    });
  });

  describe("NOT_ONE_COMMAND", () => {
    it("carries the reason", () => {
      expect(parseModelOutput("NOT_ONE_COMMAND: needs two steps")).toEqual({
        kind: "refusal",
        reason: "needs two steps",
      });
    });

    it("is case-insensitive", () => {
      expect(parseModelOutput("not_one_command: Two steps needed")).toEqual({
        kind: "refusal",
        reason: "Two steps needed",
      });
    });

    it("defaults the reason when bare", () => {
      expect(parseModelOutput("NOT_ONE_COMMAND:")).toEqual({
        kind: "refusal",
        reason: "request needs more than one command",
      });
    });

    it("defaults the reason when the tail is blank", () => {
      expect(parseModelOutput("NOT_ONE_COMMAND:   ")).toEqual({
        kind: "refusal",
        reason: "request needs more than one command",
      });
    });
  });

  describe("chatter stems", () => {
    const chatter = [
      "I'm sorry, I can't help with that",
      "sorry, no can do",
      "I cannot do that",
      "I'm unable to help with that",
      "I am unable to help with that",
      "As an AI, I cannot run that",
      "Unfortunately that needs two commands",
      "Sure! here is the command",
      "I’m sorry — that needs two commands", // typographic apostrophe
      "I can’t do that in one command",
    ];
    for (const line of chatter) {
      it(`refuses: ${line}`, () => {
        expect(parseModelOutput(line)).toEqual({
          kind: "refusal",
          reason: `model chatter instead of a command: ${line}`,
        });
      });
    }

    it("does not trigger without a boundary after the stem", () => {
      expect(parseModelOutput("surely list files")).toEqual({
        kind: "command",
        command: "surely list files",
      });
    });
  });

  describe("whole-line quote unwrapping", () => {
    it("unwraps backticks", () => {
      expect(parseModelOutput("`ls -la`")).toEqual({ kind: "command", command: "ls -la" });
    });

    it("unwraps double quotes", () => {
      expect(parseModelOutput('"ls -la"')).toEqual({ kind: "command", command: "ls -la" });
    });

    it("unwraps single quotes", () => {
      expect(parseModelOutput("'ls -la'")).toEqual({ kind: "command", command: "ls -la" });
    });

    it("refuses an empty quoted pair as empty output", () => {
      expect(parseModelOutput('""')).toEqual(EMPTY);
    });

    it("keeps an unmatched leading quote", () => {
      expect(parseModelOutput('"ls -la')).toEqual({ kind: "command", command: '"ls -la' });
    });

    it("refuses a lone backtick (unwrappable, still a backtick)", () => {
      expect(parseModelOutput("`")).toEqual({
        kind: "refusal",
        reason: "command contains a backtick (broken fence or command substitution)",
      });
    });
  });

  describe("remaining backticks", () => {
    it("refuses prose around a backticked command", () => {
      expect(parseModelOutput("run `ls` to list")).toEqual({
        kind: "refusal",
        reason: "command contains a backtick (broken fence or command substitution)",
      });
    });

    it("refuses legacy command substitution", () => {
      expect(parseModelOutput("echo `date`")).toEqual({
        kind: "refusal",
        reason: "command contains a backtick (broken fence or command substitution)",
      });
    });

    it("refuses a broken fence", () => {
      expect(parseModelOutput("```bash ls")).toEqual({
        kind: "refusal",
        reason: "command contains a backtick (broken fence or command substitution)",
      });
    });
  });

  describe("bash history expansion", () => {
    const reason =
      "bash history expansion (!!, !-N, !cmd) only works in interactive shells — the full command must be written out";

    it("refuses !! (rerun-last)", () => {
      expect(parseModelOutput("!!")).toEqual({ kind: "refusal", reason });
    });

    it("refuses !-N", () => {
      expect(parseModelOutput("!-2")).toEqual({ kind: "refusal", reason });
    });

    it("refuses a chained !! after another command", () => {
      expect(parseModelOutput("cd /tmp && !!")).toEqual({ kind: "refusal", reason });
    });

    it("refuses !word event designators", () => {
      expect(parseModelOutput("!ls")).toEqual({ kind: "refusal", reason });
    });

    it("allows ! negation (followed by whitespace)", () => {
      expect(parseModelOutput("! grep -q foo bar.txt")).toEqual({
        kind: "command",
        command: "! grep -q foo bar.txt",
      });
    });

    it("allows a literal mid-word !! inside a quoted string", () => {
      expect(parseModelOutput("echo 'hi!!'")).toEqual({
        kind: "command",
        command: "echo 'hi!!'",
      });
    });
  });

  describe("leading shell-prompt markers", () => {
    it("strips $", () => {
      expect(parseModelOutput("$ ls -la")).toEqual({ kind: "command", command: "ls -la" });
    });

    it("strips %", () => {
      expect(parseModelOutput("% git status")).toEqual({
        kind: "command",
        command: "git status",
      });
    });

    it("strips >", () => {
      expect(parseModelOutput("> docker ps")).toEqual({ kind: "command", command: "docker ps" });
    });
  });

  describe("length cap", () => {
    it(`accepts exactly ${MAX_COMMAND_LENGTH} characters`, () => {
      const cmd = "a".repeat(MAX_COMMAND_LENGTH);
      expect(parseModelOutput(cmd)).toEqual({ kind: "command", command: cmd });
    });

    it(`refuses ${MAX_COMMAND_LENGTH + 1} characters`, () => {
      expect(parseModelOutput("a".repeat(MAX_COMMAND_LENGTH + 1))).toEqual({
        kind: "refusal",
        reason: "command exceeds maximum length of 2000 characters",
      });
    });
  });
});