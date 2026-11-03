import { describe, it, expect } from "vitest";
import { matchesCrisisPhrase, applyCrisisBackstop, normalizeForCrisisMatch } from "@/lib/personas/prompt";
import { config } from "@/lib/config";

describe("matchesCrisisPhrase", () => {
  it("matches an explicit crisis phrase", () => {
    expect(matchesCrisisPhrase("I want to kill myself")).toBe(true);
  });

  it("does not match ordinary chat", () => {
    expect(matchesCrisisPhrase("I had a rough day at work")).toBe(false);
  });

  // Issue 1 regression (adversarial review): /\bsuicidal?\b/ matches
  // "suicidal" but can never match the plain noun "suicide", since it
  // only allows an optional trailing "l" after "suicida". These cases
  // reproduce the miss directly, without requiring "commit"/"committing"
  // immediately before the word.
  it("matches the plain noun 'suicide' with no 'commit' verb nearby", () => {
    expect(matchesCrisisPhrase("thinking about suicide")).toBe(true);
    expect(matchesCrisisPhrase("my suicide plan is ready")).toBe(true);
    expect(matchesCrisisPhrase("I want to attempt suicide tonight")).toBe(true);
  });

  it("still matches 'suicidal'", () => {
    expect(matchesCrisisPhrase("I am suicidal")).toBe(true);
  });

  // Finding 1 (adversarial review, second pass): the explicit phrasings
  // the review called out as missed before this round of fixes.
  describe("finding 1: previously-missed English phrasings", () => {
    const cases: [string, string][] = [
      ["thinking of killing myself", "I'm thinking of killing myself"],
      ["going to hang myself", "I'm going to hang myself"],
      ["took all my pills", "I took all my pills"],
      ["swallowed the whole bottle", "I swallowed the whole bottle"],
      ["wish I was dead", "I wish I was dead"],
      ["don't want to live anymore", "I don't want to live anymore"],
      ["better off without me", "everyone would be better off without me"],
      ["can't do this anymore", "I can't do this anymore"],
      ["cutting myself again", "I've been cutting myself again"],
      ["grief: coming to join you, dad", "I'm coming to join you, dad"],
      ["grief: be with you soon, mom", "I'll be with you soon, mom"],
    ];
    for (const [label, phrase] of cases) {
      it(`matches: ${label}`, () => {
        expect(matchesCrisisPhrase(phrase)).toBe(true);
      });
    }
  });

  describe("finding 1: typing tricks normalized before matching", () => {
    it("matches curly apostrophes", () => {
      expect(matchesCrisisPhrase("I can’t go on living")).toBe(true);
    });

    it("matches a zero-width character inserted mid-word", () => {
      expect(matchesCrisisPhrase("I want to kill​myself")).toBe(true);
    });

    it("matches common leetspeak digit substitutions", () => {
      expect(matchesCrisisPhrase("k1ll mys3lf")).toBe(true);
    });

    it("matches a Cyrillic-homoglyph spelling of 'suicide'", () => {
      // Cyrillic а/с/е substituted for the Latin look-alikes.
      expect(matchesCrisisPhrase("I am thinking about suicidе")).toBe(true);
    });

    // Adversarial-review follow-up on finding 1: a second pass found
    // these specific gaps in the first round of typing-trick coverage.
    it("matches a hyphen used as a word separator", () => {
      expect(matchesCrisisPhrase("I want to kill-myself")).toBe(true);
    });

    it("matches an underscore used as a word separator", () => {
      expect(matchesCrisisPhrase("kill_myself")).toBe(true);
    });

    it("matches '!' used as a look-alike for 'i'", () => {
      expect(matchesCrisisPhrase("k!ll myself")).toBe(true);
    });

    it("matches '1' used as a look-alike for 'l' (not just 'i')", () => {
      expect(matchesCrisisPhrase("ki11 myself")).toBe(true);
    });

    it("matches 'wanna die' and 'want 2 die'", () => {
      expect(matchesCrisisPhrase("I just wanna die")).toBe(true);
      expect(matchesCrisisPhrase("I want 2 die")).toBe(true);
    });

    // Adversarial-review follow-up (second pass on this round's fixes):
    // folding every "!" to "i" unconditionally turned "die!" into
    // "diei", which broke the trailing \b boundary every pattern relies
    // on, so a crisis phrase followed by an exclamation mark silently
    // stopped matching. Deepgram transcripts routinely end a sentence
    // with "!". These must all still match.
    it("still matches when the phrase is followed by an exclamation mark", () => {
      expect(matchesCrisisPhrase("I want to die!")).toBe(true);
      expect(matchesCrisisPhrase("kms!")).toBe(true);
      expect(matchesCrisisPhrase("I am thinking about suicide!")).toBe(true);
      expect(matchesCrisisPhrase("I'm going to kill myself!")).toBe(true);
      expect(matchesCrisisPhrase("I want to end my life!")).toBe(true);
      expect(matchesCrisisPhrase("better off dead!")).toBe(true);
      expect(matchesCrisisPhrase("end it all!")).toBe(true);
      expect(matchesCrisisPhrase("I have the pills!")).toBe(true);
      expect(matchesCrisisPhrase("I just wanna die!")).toBe(true);
      expect(matchesCrisisPhrase("quiero matarme!")).toBe(true);
    });

    it("'!' as a mid-word letter substitute still folds to 'i'", () => {
      expect(matchesCrisisPhrase("k!ll myself")).toBe(true);
    });
  });

  describe("finding 1 follow-up: Devanagari spelling variants", () => {
    it("matches the nukta spelling ख़ुदकुशी (vs the plain खुदकुशी already covered)", () => {
      // ख + nukta (U+093C) + ुदकुशी
      const withNukta = "ख़ुदकुशी";
      expect(matchesCrisisPhrase(withNukta)).toBe(true);
    });

    it("matches the chandrabindu spelling of हूँ (vs the anusvara हूं already covered)", () => {
      // "मैं मरना चाहता हूँ" with chandrabindu U+0901 on हूँ.
      const withChandrabindu = "मरना चाहता हूँ";
      expect(matchesCrisisPhrase(withChandrabindu)).toBe(true);
    });

    it("normalizeForCrisisMatch is idempotent-ish: already-plain text passes through lowercased", () => {
      expect(normalizeForCrisisMatch("Hello World")).toBe("hello world");
    });
  });

  describe("finding 1: Spanish crisis phrasing", () => {
    it("matches 'quiero matarme'", () => {
      expect(matchesCrisisPhrase("quiero matarme")).toBe(true);
    });

    it("matches 'no quiero vivir más' (accented, normalized to unaccented)", () => {
      expect(matchesCrisisPhrase("no quiero vivir más")).toBe(true);
    });

    it("matches 'me quiero morir'", () => {
      expect(matchesCrisisPhrase("me quiero morir")).toBe(true);
    });
  });

  describe("finding 1: Hindi crisis phrasing", () => {
    it("matches 'मुझे मरना है'", () => {
      expect(matchesCrisisPhrase("मुझे मरना है")).toBe(true);
    });

    it("matches 'आत्महत्या करना चाहता हूं'", () => {
      expect(matchesCrisisPhrase("आत्महत्या करना चाहता हूं")).toBe(true);
    });
  });

  // Finding 3 (third adversarial review): common SPOKEN English
  // phrasings a real speech-to-text provider would actually produce.
  describe("finding 3: previously-missed spoken English phrasings", () => {
    const cases: [string, string][] = [
      ["going to shoot myself", "I'm going to shoot myself"],
      ["want to stab myself", "I want to stab myself"],
      ["drown myself", "I'm going to drown myself"],
      ["off myself", "I want to off myself"],
      ["want to end it", "I want to end it"],
      ["thinking about ending it", "I've been thinking about ending it"],
      ["dont wanna live", "I dont wanna live"],
      ["don't want to be here anymore", "I don't want to be here anymore"],
      ["sleep and never wake up", "I want to sleep and never wake up"],
      ["won't be around much longer", "I won't be around much longer"],
    ];
    for (const [label, phrase] of cases) {
      it(`matches: ${label}`, () => {
        expect(matchesCrisisPhrase(phrase)).toBe(true);
      });
    }
  });

  // Adversarial-review follow-up (fourth pass): casual "wanna"/"gonna"
  // contractions of two of the finding-3 phrasings above, which the
  // original /\bwant(?:ed|s|ing)?\s+to\s+end\s+it\b/ and
  // /\boff\s+my\s*self\b/-via-"gonna" paths did not cover.
  describe("finding 8: casual contraction variants of finding 3 phrasings", () => {
    it("matches 'wanna end it'", () => {
      expect(matchesCrisisPhrase("I just wanna end it")).toBe(true);
    });

    it("matches 'gonna off myself'", () => {
      expect(matchesCrisisPhrase("I'm gonna off myself")).toBe(true);
    });
  });

  describe("finding 1: benign text still does not trip", () => {
    it("does not match an ordinary rough day", () => {
      expect(matchesCrisisPhrase("I had a rough day at work")).toBe(false);
    });

    it("does not match a fun-fact request", () => {
      expect(matchesCrisisPhrase("tell me a fun fact")).toBe(false);
    });
  });
});

describe("applyCrisisBackstop", () => {
  it("appends the resources line when the user message matched and the reply lacks it", () => {
    const reply = applyCrisisBackstop("I want to end my life", "I'm here with you.");
    expect(reply).toContain(config.crisisResources);
  });

  it("does not duplicate the resources line if the reply already has it", () => {
    const already = `I'm here with you. ${config.crisisResources}`;
    const reply = applyCrisisBackstop("I want to end my life", already);
    expect(reply).toBe(already);
  });

  it("leaves an ordinary reply untouched", () => {
    const reply = applyCrisisBackstop("tell me a fun fact", "Sure, here's one.");
    expect(reply).toBe("Sure, here's one.");
  });
});
