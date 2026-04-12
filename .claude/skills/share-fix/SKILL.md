---
name: share-fix
description: After shipping a non-trivial fix, find related GitHub issues across the ecosystem, draft helpful human-sounding comments linking the fix and root cause, and optionally file upstream issues. Drafts must pass as human writing or the user's GitHub reputation suffers. Works on the current session's fix or retroactively on past commits/PRs. Always asks for approval before posting anything public.
argument-hint: "[optional: commit SHA, PR number, or description of the fix]"
---

# Share Fix Agent

## Target: $ARGUMENTS

After fixing a non-trivial bug, especially one rooted in a third-party library or package, find other people hitting the same issue across GitHub and leave helpful comments pointing to the fix. The goal is to be a good open-source neighbor: save other developers hours of debugging by making findings searchable.

Use this skill whenever a merged fix works around or documents an upstream bug that other downstream projects likely hit or will hit. Typical triggers: a library minification bug, a terminal emulator quirk, a polyfill issue, a protocol-level misbehavior, a platform-specific gotcha.

## Voice Calibration (Always Run First)

**Critical:** GitHub culture is allergic to AI-written content. If a comment drafted for the user is detected as AI, the user's reputation takes real damage. Drafts must pass as human on first read. This is not optional.

Before drafting anything, load voice context:

1. **Read memory files.** Check `~/.claude/projects/*/memory/` for files like `feedback_comment_style.md`, `feedback_no_em_dashes.md`, `user_*.md`. Read the bodies, not just the MEMORY.md index. These carry the user's voice rules, honest project positioning, and hard writing constraints (em dashes, "we" vs "i", etc).
2. **Sample recent comments from the user in the target repo.** For each target repo:
   ```
   gh search issues --commenter <user> --repo <owner>/<name> --limit 10 --include-prs
   gh api repos/<owner>/<name>/issues/<n>/comments --jq '.[] | select(.user.login == "<user>") | .body'
   ```
   Read a couple of the user's actual comments. Mimic their length, lowercase pattern, shorthand, and emotional register.
3. **Only then start Step 1.** Drafts written from a default corporate register and casualized afterwards always read as "AI trying to sound casual". Start in the right register.

## Step 1: Understand the Fix

Before searching the ecosystem, understand what the fix actually does:

- Read the commit diff, PR description, and any referenced issue body
- Identify the **root cause** (not just the symptom): what third-party behavior or bug is being worked around?
- Identify the **upstream package** and version involved
- Identify the **downstream symptom**: what did end users actually see?
- Identify the **workaround mechanism**: what change makes the symptom go away?

If any of these are unclear from the commit or PR alone, read the relevant source files, including the published `node_modules` source for the upstream package, before proceeding. Do not start drafting comments until you can explain all four in plain language. Guessed root causes damage the user's credibility when they turn out wrong.

## Step 2: Research Outreach Targets

Dispatch a `researcher` subagent. The research is wide-ranging and benefits from parallel searching across many repos. Brief it on:

- The root cause in technical terms
- The symptoms users would describe in layperson terms
- The upstream package and version
- Example search vocabulary both technical users and lay users might use
- The honest, non-marketing framing for the user's project (pulled from memory)

Ask it to return, ranked by confidence:

1. **Open or recent issues on the upstream repo** matching the symptom or root cause
2. **Existing issues on downstream projects** that use the same package and might have hit this
3. **High-traffic discussion megathreads** where affected users are gathering (highest-leverage comment targets)
4. **Closed issues** still highly-reacted or searchable, where a comment would help future searchers
5. **The right upstream tracker** to file a new issue if none exists

The researcher should return URLs, issue numbers, match rationale, and confidence ratings. Skip low-confidence targets to avoid spamming. A comment on the wrong issue damages signal for everyone.

**Also check which targets the user has already commented on** via `gh search issues --commenter <user> --repo <owner>/<name>` so the skill does not duplicate outreach.

## Step 3: Draft Comments (Always, Not Post Yet)

Draft tone guidance (read this every time):

- **First person singular always.** "i hit this", "i built", "my fix". Never "we" unless the user has explicitly said they're part of a team.
- **Lowercase starts on most sentences in informal comments.** Including the word "i". Some caps are fine, consistent Title Case is not.
- **Shorthand.** `w/` for with, `rn` for right now, `imo`, `afaik`, `tbh`, `btw`, `fwiw`, `repro`, `prod`, `config`, `deps`. Write `xtermjs` not `xterm.js` in prose. `electron`, `vscode` lowercase. Natural, not performative.
- **Short sentences mixed with occasional run-ons.** Don't over-polish. Comma splices are fine. Sentence fragments for emphasis are fine.
- **Drop the link, state what it does, done.** No sign-offs. No "hope this helps". No "let me know if you have questions". The comment ends when the information ends.
- **Honest project positioning.** Load from memory. Describe the user's project factually. Not "small indie wrapper", not "the leading X for Y".
- **Emotional honesty where natural.** "was mad enough to fix it myself", "took me a while to untangle". Don't force it, don't suppress it.
- **No corporate phrasing.** No "I wanted to share", "I hope this is helpful", "happy to provide more context", "looking forward to your thoughts". These are AI tells.
- **No bulleted "key takeaways" in informal comments.** Prose only. Save bullets for upstream issue bodies where structure pulls its weight.
- **No em dashes.** Hard rule. Only `,`, `;`, `:`, `-` (hyphen-minus for compounds and lists), or sentence breaks. Scan every draft for `—` before presenting and rewrite any that appear.
- **No "Summary / Symptom / Root Cause / Impact / Solution" section headers in informal comments.** This is an AI-writing tell. Save structured markdown for upstream issue bodies.
- **Don't always close parentheticals perfectly.** Slightly imperfect punctuation is more human than ChatGPT-grade polish. Don't insert typos performatively, but don't obsessively polish either.
- **Don't summarize at the end.** Human comments trail off; AI comments tie a bow.

For each confirmed target, draft a comment that follows this shape:

1. **Open with honest project context in first person singular.** Match the casual lowercase tone if the target repo's threads use it. Example opener: `hey, hit the same bug in Pane (my cross-platform terminal-first ai code assistant manager for running claude code / codex in parallel worktrees).`
2. **Acknowledge the other person's report** by @username if the target is an issue thread. Credit workaround proposals.
3. **Explain the root cause in plain language.** Short paragraphs. The reader is technical but hasn't spent hours on this specific bug.
4. **Show the fix.** Code snippet if small. Link to commit or PR if larger.
5. **Link upstream context.** If you filed an upstream issue, link it. Cite adjacent issues or PRs if relevant.
6. **Offer a user-facing workaround** if one exists for end users who can't patch the terminal wrapper themselves.

Vary the wording across targets. Identical boilerplate posted to multiple threads reads as spam even when the content is helpful.

After drafting, re-read once and ask: "would a human who just spent 6 hours debugging this at 2am write exactly this?" If any sentence feels too polished, unpolish it.

## Step 4: File Upstream Issues (If None Exist)

For upstream issue bodies, relax the lowercase-casual aspect because structure is expected there. Keep: first-person-singular, honest positioning, no em dashes, no corporate sign-offs.

Structure:

- **Title**: concrete and searchable, include package name, version, and specific symptom
- **Summary**: 2 or 3 sentences stating the bug and who it affects
- **Reproduction**: minimal steps
- **Root cause**: technical analysis with a code excerpt from the upstream source
- **Impact**: who hits this and under what conditions
- **Suggested upstream fixes**: ranked options the maintainer can pick from
- **Downstream workaround**: what consumers can do in the meantime
- **Environment**: versions, OS

Err on the side of thorough for upstream issues. This is where maintainers decide whether to prioritize the fix.

## Step 5: Review With User Before Posting

**CRITICAL**: Do not post comments or file issues without explicit user approval. Each is a high-visibility, irreversible action. A deleted comment still shows in issue history; a filed issue still sends notifications.

Present the full plan:

- Ranked list of targets with confidence
- Full draft of each comment
- Full draft of any upstream issue
- Ask: "approve all, approve some, edit any, or skip any?"

When the user approves, post via:

```
gh issue comment <n> --repo owner/repo --body "$(cat <<'EOF'
...
EOF
)"
```

and file new issues via:

```
gh issue create --repo owner/repo --title "..." --body "$(cat <<'EOF'
...
EOF
)"
```

Use heredocs for multi-line bodies. Confirm each post succeeded and report back the final URLs.

## Step 6: Record Outreach

After posting, write an outreach record to `./tmp/outreach/YYYY-MM-DD-topic.md` with:

- Links to every comment posted
- Links to any upstream issue filed
- Anything notable in responses (for follow-up)

This creates a trail so future retroactive runs don't duplicate outreach.

## Anti-patterns

- **Do not post identical comments across threads.** Vary wording, cite different adjacent issues, emphasize the slice most relevant to each thread.
- **Do not sound like AI.** This is the #1 failure mode. Avoid corporate phrasing, section headers in informal comments, tied-bow closers, em dashes, overly formal structure. Pass-as-human is a hard requirement.
- **Do not oversell.** Marketing-speak fails.
- **Do not under-sell.** If the user is building a real product, don't reduce it to "small wrapper" or "tiny side project". Load correct positioning from memory.
- **Do not use "we" when the user is a solo operator.** First person singular by default.
- **Do not use em dashes.** Hard rule. Scan every draft before presenting.
- **Do not guess at root cause.** If you haven't read the upstream source yourself, Step 1 is not complete.
- **Do not drive-by megathreads with "me too".** Every comment adds new technical information or a concrete workaround.
- **Do not comment on closed issues if the comment adds nothing.** Only drop into a closed thread when genuinely additive for future searchers.
- **Do not post without approval.** Rule applies every run, every comment. No exceptions.
- **Do not batch-iterate over many commits in one skill run.** Run the skill once per fix.

## Retroactive / Batch Mode

When the argument is a commit SHA, PR number, or vague description of a past fix:

1. Use `git log --oneline` and `git show <sha>` to locate and read the commit
2. Use `gh pr view <n>` for PR context
3. Read the published upstream package source as it existed at fix time if relevant
4. Run the full workflow from Voice Calibration forward
5. Each skill run is self-contained; chain additional `/share-fix <other-sha>` runs as needed

Stay focused on one fix per invocation to keep research and drafting deep rather than shallow.

## Suggested Next Steps (after run completes)

```
Outreach record saved to ./tmp/outreach/[filename]

Suggested next steps:
- `/share-fix <another-commit>` to retroactively share a different past fix
- Watch the filed upstream issue for maintainer response
- Check back in a few weeks to see if upstream shipped a source-level fix
```
