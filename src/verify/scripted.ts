import type { Verifier, VerifierInput, VerifyPayload } from "../types.js";

/** Returns scripted verdicts in order; the last one repeats. For fixtures and tests only. */
export class ScriptedVerifier implements Verifier {
  readonly name = "scripted";
  readonly inputs: VerifierInput[] = [];
  private i = 0;
  constructor(private readonly verdicts: VerifyPayload[]) {
    if (verdicts.length === 0) throw new Error("ScriptedVerifier needs at least one verdict");
  }
  async verify(input: VerifierInput): Promise<VerifyPayload> {
    this.inputs.push(input);
    const v = this.verdicts[Math.min(this.i++, this.verdicts.length - 1)]!;
    return v;
  }
}
