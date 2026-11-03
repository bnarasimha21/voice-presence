// Issue 6: approximate per-unit list prices used only to estimate cost per
// turn in the eval report. These are placeholders, not a billing source of
// truth: check current vendor pricing pages before trusting a number here
// for anything beyond a rough comparison between eval runs.

export const pricing = {
  llmInputPerMillionTokens: 3,
  llmOutputPerMillionTokens: 15,
  sttPerMinute: 0.0043 * 60,
  ttsPerThousandChars: 0.18,
};

export function estimateCostUsd(usage: {
  llmInputTokens: number;
  llmOutputTokens: number;
  sttSeconds: number;
  ttsChars: number;
}): number {
  const llmCost =
    (usage.llmInputTokens / 1_000_000) * pricing.llmInputPerMillionTokens +
    (usage.llmOutputTokens / 1_000_000) * pricing.llmOutputPerMillionTokens;
  const sttCost = (usage.sttSeconds / 60) * pricing.sttPerMinute;
  const ttsCost = (usage.ttsChars / 1000) * pricing.ttsPerThousandChars;
  return llmCost + sttCost + ttsCost;
}
