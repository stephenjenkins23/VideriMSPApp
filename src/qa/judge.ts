/**
 * LLM-as-judge — for the properties graders cannot check.
 *
 * Used sparingly and deliberately. Anything mechanically checkable (invented
 * numbers, undisclosed gaps, unsupported severity) belongs in graders.ts, which
 * is free, fast, and deterministic. The judge covers only genuinely subjective
 * questions: did it lead with the right thing, is the advice actionable.
 *
 * Judge scores are noisy. They gate on a *mean across repetitions* and are never
 * the sole reason a release fails — treat a drop as a signal to read the output,
 * not as a verdict.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { FleetBundle } from "../ai/bundle.js";
import type { FleetBrief } from "../ai/brief.js";

const JudgementSchema = z.object({
  leadsWithWhatMatters: z.number().int().min(1).max(5)
    .describe("Does the headline name the single most important fact in the data? 5 = yes, 1 = buried or wrong."),
  actionability: z.number().int().min(1).max(5)
    .describe("Could an operator act on this without asking follow-up questions? 5 = concrete next steps."),
  honestyAboutLimits: z.number().int().min(1).max(5)
    .describe("Does it represent the limits of the data accurately — neither hiding gaps nor over-hedging? 5 = exactly right."),
  concision: z.number().int().min(1).max(5)
    .describe("Free of padding and filler? 5 = every sentence earns its place."),
  worstProblem: z.string()
    .describe("The single biggest problem with this brief, in one sentence. If none, say 'none'."),
});

export type Judgement = z.infer<typeof JudgementSchema>;

const JUDGE_SYSTEM = `You are a strict reviewer of automated operations briefings for a digital-signage fleet management product.

You will be shown the raw fleet data that was available, and the brief that was generated from it. Score the brief against the rubric.

Be demanding. A 5 means genuinely excellent, not merely acceptable. A brief that is fluent but says nothing useful should score low on actionability regardless of how well it reads.

Pay particular attention to honesty about limits. Much of this fleet's telemetry is unreadable — the data will tell you which metrics are unavailable. A brief that implies healthy hardware it could not measure is dangerous and must score 1 or 2 on honestyAboutLimits, however confident it sounds. Equally, a brief that hedges everything into uselessness when the data IS complete is also failing — over-hedging scores low too.

Judge only what is in front of you. Do not reward a brief for information it could not have had.`;

export async function judgeBrief(
  bundle: FleetBundle,
  brief: FleetBrief,
  client = new Anthropic(),
): Promise<Judgement> {
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(JudgementSchema) },
    system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `FLEET DATA AVAILABLE:\n${JSON.stringify(bundle, null, 2)}\n\nBRIEF PRODUCED:\n${JSON.stringify(brief, null, 2)}`,
      },
    ],
  });

  if (!response.parsed_output) throw new Error("Judge returned no parseable output.");
  return response.parsed_output;
}

export const judgeMean = (j: Judgement): number =>
  (j.leadsWithWhatMatters + j.actionability + j.honestyAboutLimits + j.concision) / 4;
