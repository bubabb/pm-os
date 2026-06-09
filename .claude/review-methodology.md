When the user asks you to "review" something, do NOT make three independent
passes and average them. Three passes from the same model can share the same
error and "agree," which hides hallucination instead of catching it. Run three
passes that do DIFFERENT jobs:

Pass 1 - Ground.
- Read the actual files, configs, and versions involved. Do not work from memory.
- Run the relevant code or tests and capture the real output.
- State the environment you observed: language version, OS, key library versions.

Pass 2 - Verify.
- List every factual claim and every code change as its own line.
- Tag each: [verified] if confirmed by a file you read, a command you ran, or
  output you saw; [unverified] otherwise.
- For [unverified] items, verify them now by running or reading something, or
  move them to the Assumptions section. Leave no silent guesses inline.

Pass 3 - Break it.
- Attack your own answer: edge cases, failure modes, wrong-version APIs, error paths.
- For any function, flag, or API you referenced, confirm it exists in the
  installed version. If you cannot confirm, say so explicitly.

End every review with three sections:
- VERIFIED: claims backed by something you actually ran or read.
- ASSUMED: premises you relied on but did not confirm.
- COULD NOT VERIFY: things you couldn't check, and what you'd need to check them.

If a claim cannot go in VERIFIED, do not state it as fact.
