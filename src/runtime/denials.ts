/**
 * Failures that will not become successes.
 *
 * A tool call can fail for two very different reasons. It can fail because the
 * arguments were wrong — a bad id, a missing field, a name that does not exist
 * yet — and then trying again with better arguments is exactly the right move.
 * Or it can fail because the ENVIRONMENT will not perform that operation for
 * this identity at all: the token lacks a scope, the account lacks a licence,
 * the project denies the permission. No argument list fixes that, and every
 * retry costs a step, a model call, and — when the operation is gated — a
 * human's attention on an approval prompt for a call that is already known to
 * be dead.
 *
 * Observed (run 20260914T015933Z-4a2806d0): Azure DevOps answered
 * `testplan_test_plan_write` with "You are not authorized to access this API"
 * four times. The model varied `iteration` and `areaPath` between attempts, so
 * the loop's repeat memo — which keys on the exact arguments — never saw a
 * repeat, and the reviewer was asked to approve the same doomed write three
 * more times. This module is what lets the loop recognise the class of failure
 * and refuse the operation itself.
 *
 * The check is deliberately narrow. A false positive silently removes a
 * capability from the run, so only phrases that unambiguously denote
 * authorization are matched; a generic "failed" or "error" is not enough.
 */

/**
 * Identity of an OPERATION, not of a call: the tool name plus the multiplexed
 * `action` when there is one. Azure DevOps tools carry several operations
 * behind one name, and it is the operation that is authorized or not —
 * `testplan` list_plans succeeds while `testplan_test_plan_write` create is
 * refused, and one must not disable the other.
 */
export function operationKey(toolName: string, args: Record<string, unknown>): string {
  const action = args["action"];
  return typeof action === "string" && action.length > 0 ? `${toolName}#${action}` : toolName;
}

/** Phrases that mean "not allowed", as opposed to "not like that". */
const AUTHORIZATION = [
  /not authorized to access this api/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\baccess denied\b/i,
  /\bpermission denied\b/i,
  /do(es)? not have (the )?permission/i,
  /you (are )?not (a )?(member|licensed)/i,
  /requires? an? .*(licen[cs]e|access level)/i,
  /\bTF400813\b/, // Azure DevOps: the user is not authorized to access this resource
  /\bVS402455\b/, // Azure DevOps: Test Plans access level required
];

/** How much of a result to scan. Errors put the reason first; bodies can be huge. */
const SCAN_CHARS = 4_000;

function textOf(result: unknown): string {
  if (typeof result === "string") return result.slice(0, SCAN_CHARS);
  if (result !== null && typeof result === "object") {
    const message = (result as Record<string, unknown>)["message"];
    if (typeof message === "string") return message.slice(0, SCAN_CHARS);
    try {
      return JSON.stringify(result).slice(0, SCAN_CHARS);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * The sentence that shows this failed for authorization, or `undefined` when
 * the failure looks like something a different call could fix. Returns the
 * matching line rather than a boolean so the loop can quote the environment
 * back to the model instead of paraphrasing it.
 */
export function authorizationFailure(result: unknown): string | undefined {
  const text = textOf(result);
  if (!text) return undefined;
  if (!AUTHORIZATION.some((re) => re.test(text))) return undefined;
  // The most informative line is the one that matched; untagged content lines
  // (the MCP untrusted-content fences) are skipped.
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("<<") && AUTHORIZATION.some((re) => re.test(l)));
  return line ?? text.trim().slice(0, 300);
}

/**
 * What the model is told when it proposes an operation the environment has
 * already refused. It names the operation, quotes the refusal, and closes the
 * door explicitly — a model that is merely told "failed" will reasonably try
 * again with different arguments, which is the behaviour this exists to stop.
 */
export function deniedOperationReason(key: string, quoted: string): string {
  return (
    `${key} is not available to this run: the environment refused it — "${quoted}". ` +
    `This is a permission or licence decision about the operation itself, not about the ` +
    `arguments, so no retry and no variation of the arguments will succeed. Do not propose ` +
    `it again. Complete whatever else the task allows and report this as a limitation of ` +
    `the environment.`
  );
}
