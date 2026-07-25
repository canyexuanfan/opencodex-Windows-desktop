"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MARKER,
  END_MARKER,
  CONTROL_MARKER,
  BOT_LOGIN,
  ISSUE_BODY_MAX,
  hashTranslationSource,
  splitTranslationBlock,
  stripTranslationBlock,
  appendTranslationBlock,
  buildTranslationBlock,
  buildTranslationControlComment,
  findControlComment,
  extractTranslationControlState,
  resolveControlState,
  readFileControlState,
  writeFileControlState,
  encodeControlState,
  decodeControlState,
  validateControlState,
  mergeTranslationAttemptState,
  persistTranslationControlState,
  upsertTranslationControlComment,
  isPreparedSourceStillCurrent,
  shouldTranslate,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  isEnglishDetectedLanguage,
  stripOrphanBodyControlState,
  fitTranslationBody,
  collectEligibleControlCommentCleanupIds,
  deleteVerifiedControlComments,
} = require("./issue-translation.cjs");

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const ORPHAN_MARKER = `<!-- opencodex-issue-inline-translator-control-state-v2:${"a".repeat(16)} -->`;

const SOURCE = [
  "### Was funktioniert nicht?",
  "Der Proxy startet nicht nach dem Update.",
  "### Schritte",
  "1. ocx start",
  "2. Fehler in der Konsole",
].join("\n");

function botComment(body, id = 1) {
  return { id, user: { login: BOT_LOGIN }, body };
}

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-translation-state-"));
  const prev = process.env.OCX_TRANSLATION_STATE_DIR;
  process.env.OCX_TRANSLATION_STATE_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (prev === undefined) delete process.env.OCX_TRANSLATION_STATE_DIR;
      else process.env.OCX_TRANSLATION_STATE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

describe("hashTranslationSource", () => {
  it("changes when only the title changes", () => {
    const bodyOnly = hashTranslationSource({ body: SOURCE });
    const withTitle = hashTranslationSource({ title: "Neuer Titel", body: SOURCE });
    assert.notEqual(bodyOnly, withTitle);
  });

  it("changes when only the body changes", () => {
    const base = hashTranslationSource({ title: "Titel", body: SOURCE });
    const edited = hashTranslationSource({ title: "Titel", body: SOURCE + "\nmehr" });
    assert.notEqual(base, edited);
  });

  it("is stable for unchanged title and body", () => {
    const a = hashTranslationSource({ title: "T", body: SOURCE });
    const b = hashTranslationSource({ title: "T", body: SOURCE });
    assert.equal(a, b);
  });
});

describe("splitTranslationBlock", () => {
  it("handles generated block at end", () => {
    const translated = appendTranslationBlock(SOURCE, "English");
    const split = splitTranslationBlock(translated);
    assert.equal(split.sourceBody, SOURCE);
    assert.ok(split.block.includes(MARKER));
  });

  it("preserves suffix after generated block", () => {
    const suffix = "Extra logs added by contributor.";
    const translated = appendTranslationBlock(SOURCE, "English") + "\n\n" + suffix;
    const split = splitTranslationBlock(translated);
    assert.equal(split.suffix, suffix);
    assert.equal(split.sourceBody, `${SOURCE}\n\n${suffix}`);
  });

  it("preserves prefix before generated block", () => {
    const prefix = "Preface";
    const translated = prefix + "\n\n" + appendTranslationBlock(SOURCE, "English").trimStart();
    const split = splitTranslationBlock(translated);
    assert.equal(split.prefix, `${prefix}\n\n${SOURCE}`);
    assert.equal(split.sourceBody, `${prefix}\n\n${SOURCE}`);
  });

  it("does not remove contributor-authored details elsewhere", () => {
    const contributorDetails = [
      "<details><summary>My notes</summary>",
      "private repro notes",
      "</details>",
    ].join("\n");
    const body = contributorDetails + "\n\n" + appendTranslationBlock(SOURCE, "English").trimStart();
    const split = splitTranslationBlock(body);
    assert.ok(split.sourceBody.includes("private repro notes"));
    assert.ok(split.sourceBody.includes("My notes"));
  });

  it("fails safely when closing details is missing", () => {
    const malformed = `${SOURCE}\n\n${MARKER}\n<details>\n<summary>Translated Message</summary>\n\noops`;
    const split = splitTranslationBlock(malformed);
    assert.ok(split.sourceBody.includes("oops"));
    assert.ok(split.sourceBody.includes(SOURCE));
  });

  it("preserves nested details inside translated content via end marker", () => {
    const nested = [
      "Outer translation",
      "<details><summary>logs</summary>",
      "inner",
      "</details>",
      "still translation",
    ].join("\n");
    const body = appendTranslationBlock(SOURCE, nested) + "\n\nuser suffix";
    assert.ok(body.includes(END_MARKER));
    const split = splitTranslationBlock(body);
    assert.equal(split.suffix, "user suffix");
    assert.equal(split.sourceBody, `${SOURCE}\n\nuser suffix`);
    assert.ok(split.block.includes("inner"));
    assert.ok(split.block.includes("still translation"));
  });

  it("removes multi-level nested details only inside the generated block", () => {
    const before = "<details><summary>before</summary>\nbefore-log\n</details>";
    const after = "<details><summary>after</summary>\nafter-log\n</details>";
    const nested = [
      "top",
      "<details><summary>L1</summary>",
      "<details><summary>L2</summary>",
      "deep",
      "</details>",
      "</details>",
      "tail",
    ].join("\n");
    const body = [
      before,
      "",
      appendTranslationBlock(SOURCE, nested).trimStart(),
      "",
      after,
    ].join("\n");
    const stripped = stripTranslationBlock(body);
    assert.ok(stripped.includes("before-log"));
    assert.ok(stripped.includes("after-log"));
    assert.ok(!stripped.includes("deep"));
    assert.ok(!stripped.includes("top"));
    assert.ok(!stripped.includes(MARKER));
    assert.ok(!stripped.includes(END_MARKER));
  });

  it("migrates legacy blocks that close on first details end", () => {
    const legacy = [
      SOURCE,
      "",
      MARKER,
      "",
      "<details>",
      "",
      "<summary>Translated Message</summary>",
      "",
      "legacy english",
      "",
      "</details>",
      "",
      "user after",
    ].join("\n");
    const split = splitTranslationBlock(legacy);
    assert.equal(split.suffix, "user after");
    assert.equal(split.sourceBody, `${SOURCE}\n\nuser after`);
    const migrated = appendTranslationBlock(split.sourceBody, "fresh");
    assert.ok(migrated.includes(END_MARKER));
    assert.equal((migrated.match(new RegExp(MARKER, "g")) || []).length, 1);
    assert.ok(migrated.includes("user after"));
  });

  it("does not greedily erase across duplicate end markers", () => {
    const block = buildTranslationBlock("one");
    const forged = `${SOURCE}${block}\n${END_MARKER}\nkeep me`;
    const split = splitTranslationBlock(forged);
    assert.ok(split.sourceBody.includes("keep me"));
    assert.ok(!split.block.includes("keep me"));
    assert.equal(split.suffix, `${END_MARKER}\nkeep me`);
  });
});

describe("isPreparedSourceStillCurrent", () => {
  it("detects body changes between prepare and apply", () => {
    const prepared = hashTranslationSource({ title: "T", body: SOURCE });
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "T",
        liveBody: SOURCE + "\nnew logs",
      }),
      false,
    );
  });

  it("detects title changes between prepare and apply", () => {
    const prepared = hashTranslationSource({ title: "Alt", body: SOURCE });
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "Neu",
        liveBody: SOURCE,
      }),
      false,
    );
  });

  it("allows apply when only generated translation changed", () => {
    const prepared = hashTranslationSource({ title: "T", body: SOURCE });
  const withBlock = appendTranslationBlock(SOURCE, "English");
    assert.equal(
      isPreparedSourceStillCurrent({
        preparedHash: prepared,
        liveTitle: "T",
        liveBody: stripTranslationBlock(withBlock),
      }),
      true,
    );
  });
});

describe("bot-owned control state", () => {
  it("keeps visible bookkeeping only when a non-English translation was applied", () => {
    const comment = buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    });
    assert.match(comment, /Automated translation bookkeeping — detected language: German/);
  });

  it("English persist writes file state and never mutates comments", async () => {
    await withTempStateDir(async () => {
      const calls = [];
      const github = {
        rest: {
          issues: {
            createComment: async (args) => {
              calls.push(["create", args]);
              return { data: { id: 99, body: args.body } };
            },
            updateComment: async (args) => {
              calls.push(["update", args]);
              return { data: { id: args.comment_id } };
            },
            deleteComment: async (args) => {
              calls.push(["delete", args]);
              return {};
            },
          },
        },
      };
      const priorComment = botComment(buildTranslationControlComment({
        v: 2,
        sourceHash: HASH_B,
        attemptedAt: 1,
        recent: [1],
        requiresTranslation: true,
        detectedLanguage: "German",
      }), 7);
      const authorForged = {
        id: 8,
        user: { login: "someone" },
        body: buildTranslationControlComment({
          v: 2,
          sourceHash: HASH_B,
          attemptedAt: 1,
          recent: [1],
          requiresTranslation: false,
          detectedLanguage: "English",
        }),
      };

      const result = await persistTranslationControlState({
        github,
        owner: "o",
        repo: "r",
        issue_number: 42,
        comments: [priorComment, authorForged],
        priorState: null,
        attempt: {
          sourceHash: HASH_A,
          requiresTranslation: false,
          detectedLanguage: "English",
        },
        now: 100,
      });

      assert.equal(result.storage, "file");
      assert.equal(result.comment, null);
      assert.equal(readFileControlState(42)?.sourceHash, HASH_A);
      assert.deepEqual(calls, []);
      assert.deepEqual(result.cleanupCommentIds, [7]);
      await assert.rejects(
        () => upsertTranslationControlComment({
          github,
          owner: "o",
          repo: "r",
          issue_number: 42,
          comments: [],
          attempt: {
            sourceHash: HASH_A,
            requiresTranslation: false,
            detectedLanguage: "English",
          },
        }),
        /must not create issue comments/,
      );
    });
  });

  it("fails closed when English file storage throws and returns no cleanup IDs", async () => {
    await withTempStateDir(async () => {
      const calls = [];
      const github = {
        rest: {
          issues: {
            createComment: async (args) => {
              calls.push(["create", args]);
            },
            updateComment: async (args) => {
              calls.push(["update", args]);
            },
            deleteComment: async (args) => {
              calls.push(["delete", args]);
            },
          },
        },
      };
      await assert.rejects(
        () => persistTranslationControlState({
          github,
          owner: "o",
          repo: "r",
          issue_number: 42,
          comments: [botComment(buildTranslationControlComment({
            v: 2,
            sourceHash: HASH_B,
            attemptedAt: 1,
            recent: [1],
            requiresTranslation: true,
            detectedLanguage: "German",
          }), 7)],
          attempt: {
            sourceHash: HASH_A,
            requiresTranslation: false,
            detectedLanguage: "English",
          },
          writeFileStateFn: () => {
            throw new Error("disk full");
          },
        }),
        /storage failed/,
      );
      assert.deepEqual(calls, []);
    });
  });

  it("non-English persist writes or updates a visible bot-owned comment", async () => {
    await withTempStateDir(async () => {
      const calls = [];
      const github = {
        rest: {
          issues: {
            createComment: async (args) => {
              calls.push(["create", args]);
              return { data: { id: 50, body: args.body, user: { login: BOT_LOGIN } } };
            },
            updateComment: async (args) => {
              calls.push(["update", args]);
              return { data: { id: args.comment_id, body: args.body, user: { login: BOT_LOGIN } } };
            },
            deleteComment: async (args) => {
              calls.push(["delete", args]);
            },
          },
        },
      };

      const created = await persistTranslationControlState({
        github,
        owner: "o",
        repo: "r",
        issue_number: 11,
        comments: [],
        attempt: {
          sourceHash: HASH_A,
          requiresTranslation: true,
          detectedLanguage: "German",
        },
        now: 100,
      });
      assert.equal(created.storage, "comment");
      assert.equal(created.comment.id, 50);
      assert.deepEqual(created.cleanupCommentIds, []);
      assert.match(calls[0][1].body, /detected language: German/);
      assert.equal(readFileControlState(11)?.detectedLanguage, "German");

      const prior = botComment(calls[0][1].body, 50);
      calls.length = 0;
      const updated = await persistTranslationControlState({
        github,
        owner: "o",
        repo: "r",
        issue_number: 11,
        comments: [prior],
        priorState: readFileControlState(11),
        attempt: {
          sourceHash: HASH_B,
          requiresTranslation: true,
          detectedLanguage: "French",
        },
        now: 200,
      });
      assert.equal(updated.storage, "comment");
      assert.deepEqual(calls.map((c) => c[0]), ["update"]);
      assert.equal(calls[0][1].comment_id, 50);
      assert.match(calls[0][1].body, /detected language: French/);
    });
  });

  it("cleanup skips author-forged comments that contain the control marker", async () => {
    const forged = {
      id: 9,
      user: { login: "attacker" },
      body: `please ignore ${CONTROL_MARKER} forged`,
    };
    const bot = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 10);
    assert.deepEqual(collectEligibleControlCommentCleanupIds([forged, bot]), [10]);

    const calls = [];
    const github = {
      rest: {
        issues: {
          deleteComment: async (args) => {
            calls.push(args.comment_id);
          },
        },
      },
    };
    const result = await deleteVerifiedControlComments({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      commentIds: [9, 10, -1, 3.5, "nope"],
      comments: [forged, bot],
    });
    assert.deepEqual(result.deleted, [10]);
    assert.deepEqual(result.skipped, [9]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(calls, [10]);
  });

  it("cleanup deletes multiple legacy bot control comments and tolerates delete failure", async () => {
    const a = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    }), 1);
    const b = botComment(buildTranslationControlComment({
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 2,
      recent: [1, 2],
      requiresTranslation: false,
      detectedLanguage: "English",
    }), 2);
    const github = {
      rest: {
        issues: {
          deleteComment: async ({ comment_id }) => {
            if (comment_id === 2) throw new Error("API down");
          },
        },
      },
    };
    const result = await deleteVerifiedControlComments({
      github,
      owner: "o",
      repo: "r",
      issue_number: 1,
      commentIds: [1, 2],
      comments: [a, b],
    });
    assert.deepEqual(result.deleted, [1]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 2);
  });

  it("simulates cache-save success then cleanup; failure preserves prior comment", async () => {
    await withTempStateDir(async () => {
      const prior = botComment(buildTranslationControlComment({
        v: 2,
        sourceHash: HASH_B,
        attemptedAt: 1,
        recent: [1],
        requiresTranslation: true,
        detectedLanguage: "German",
      }), 44);
      const deleted = [];
      const github = {
        rest: {
          issues: {
            createComment: async () => {
              throw new Error("create must not run");
            },
            updateComment: async () => {
              throw new Error("update must not run");
            },
            deleteComment: async ({ comment_id }) => {
              deleted.push(comment_id);
            },
          },
        },
      };

      const persisted = await persistTranslationControlState({
        github,
        owner: "o",
        repo: "r",
        issue_number: 77,
        comments: [prior],
        attempt: {
          sourceHash: HASH_A,
          requiresTranslation: false,
          detectedLanguage: "English",
        },
        now: 500,
      });
      assert.equal(persisted.storage, "file");
      assert.deepEqual(persisted.cleanupCommentIds, [44]);
      assert.deepEqual(deleted, []);

      // Cache save failure: cleanup must not run — prior comment remains.
      const cacheSaveFailed = true;
      if (!cacheSaveFailed) {
        await deleteVerifiedControlComments({
          github,
          owner: "o",
          repo: "r",
          issue_number: 77,
          commentIds: persisted.cleanupCommentIds,
          comments: [prior],
        });
      }
      assert.deepEqual(deleted, []);
      assert.equal(readFileControlState(77)?.sourceHash, HASH_A);

      // Cache save success: cleanup may delete verified legacy comments.
      const afterSuccess = await deleteVerifiedControlComments({
        github,
        owner: "o",
        repo: "r",
        issue_number: 77,
        commentIds: persisted.cleanupCommentIds,
        comments: [prior],
      });
      assert.deepEqual(afterSuccess.deleted, [44]);
      assert.deepEqual(deleted, [44]);
      // Durable file state remains even if a later delete had failed.
      assert.equal(readFileControlState(77)?.sourceHash, HASH_A);
    });
  });

  it("resolveControlState prefers newer file state over stale comments", async () => {
    await withTempStateDir(async () => {
      const commentState = {
        v: 2,
        sourceHash: HASH_A,
        attemptedAt: 10,
        recent: [10],
        requiresTranslation: true,
        detectedLanguage: "German",
      };
      writeFileControlState(9, {
        v: 2,
        sourceHash: HASH_B,
        attemptedAt: 20,
        recent: [10, 20],
        requiresTranslation: false,
        detectedLanguage: "English",
      });
      const resolved = resolveControlState(
        [botComment(buildTranslationControlComment(commentState))],
        9,
      );
      assert.equal(resolved.sourceHash, HASH_B);
      assert.equal(resolved.requiresTranslation, false);
    });
  });

  it("selects only github-actions control comments", () => {
    const state = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    };
    const comments = [
      botComment("random bot comment"),
      botComment(buildTranslationControlComment(state)),
      { user: { login: "contributor" }, body: buildTranslationControlComment(state) },
    ];
    assert.deepEqual(extractTranslationControlState(comments), state);
  });

  it("reader and selector agree on the newest control comment", () => {
    const older = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: true,
      detectedLanguage: "German",
    };
    const newer = {
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: 2,
      recent: [1, 2],
      requiresTranslation: true,
      detectedLanguage: "Japanese",
    };
    const comments = [
      { id: 1, user: { login: BOT_LOGIN }, body: buildTranslationControlComment(older) },
      { id: 2, user: { login: BOT_LOGIN }, body: buildTranslationControlComment(newer) },
    ];
    const selected = findControlComment(comments);
    assert.equal(selected.id, 2);
    assert.deepEqual(extractTranslationControlState(comments), newer);
  });

  it("treats corrupt control state as missing", () => {
    const comments = [
      botComment(`${CONTROL_MARKER}\n<!-- opencodex-issue-inline-translator-control-state-v2:!!! -->`),
    ];
    assert.equal(extractTranslationControlState(comments), null);
  });

  it("round-trips base64url control state without HTML breakout", () => {
    const state = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 42,
      recent: [40, 42],
      requiresTranslation: true,
      detectedLanguage: "German --> @username <script>`ticks`",
    };
    const comment = buildTranslationControlComment(state);
    assert.ok(!comment.includes("--> @"));
    assert.ok(!comment.includes("<script>"));
    assert.match(comment, /control-state-v2:[A-Za-z0-9_-]+/);
    const encoded = comment.match(/control-state-v2:([A-Za-z0-9_-]+)/)[1];
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.ok(!encoded.includes(">"));
    assert.ok(!encoded.includes("@"));
    assert.ok(!encoded.includes("-->"));
    const decoded = decodeControlState(encoded);
    assert.equal(decoded.sourceHash, HASH_A);
    assert.equal(decoded.detectedLanguage, "German -- username scriptticks");
    assert.deepEqual(
      extractTranslationControlState([botComment(comment)]),
      decoded,
    );
  });

  it("rejects invalid decoded payloads", () => {
    assert.equal(decodeControlState("%%%"), null);
    assert.equal(decodeControlState(encodeControlState([1, 2])), null);
    assert.equal(validateControlState({ v: 2, sourceHash: "short", attemptedAt: 1, recent: [], requiresTranslation: true }), null);
    assert.equal(validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: Number.NaN,
      recent: [],
      requiresTranslation: true,
    }), null);
    assert.equal(validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: Number.POSITIVE_INFINITY,
      recent: Array.from({ length: 100 }, (_, i) => i),
      requiresTranslation: true,
      detectedLanguage: "Deutsch",
    }), null);
    const oversized = validateControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 10,
      recent: Array.from({ length: 100 }, (_, i) => i + 1),
      requiresTranslation: false,
      detectedLanguage: "English",
    });
    assert.equal(oversized.recent.length, 32);
  });

  it("scrubs injection characters from detected language", () => {
    assert.equal(
      scrubDetectedLanguage("German --> @username <script>"),
      "German -- username script",
    );
  });

  it("records attempts even when prior state is newer", () => {
    const now = 1_700_000_000_000;
    const prior = {
      v: 2,
      sourceHash: HASH_B,
      attemptedAt: now + 5_000,
      recent: [now + 5_000],
      requiresTranslation: false,
      detectedLanguage: "English",
    };
    const merged = mergeTranslationAttemptState({
      priorState: prior,
      attempt: {
        sourceHash: HASH_A,
        requiresTranslation: false,
        detectedLanguage: "English",
      },
      now,
    });
    assert.equal(merged.sourceHash, HASH_B);
    assert.equal(merged.attemptedAt, now + 5_000);
    assert.ok(merged.recent.includes(now));
  });

  it("strips orphan body markers without treating them as control state", () => {
    const orphan = `${SOURCE}\n\n<!-- opencodex-issue-inline-translator-control-state-v2:${encodeControlState({
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: 1,
      recent: [1],
      requiresTranslation: false,
      detectedLanguage: "English",
    })} -->\n`;
    assert.equal(extractTranslationControlState([]), null);
    assert.equal(stripOrphanBodyControlState(orphan).includes("control-state-v2:"), false);
    assert.ok(stripOrphanBodyControlState(orphan).includes("Proxy startet nicht"));
  });

  it("preserves author whitespace around orphan markers byte-for-byte", () => {
    const fixtures = [
      [`tail ${ORPHAN_MARKER}`, "tail "],
      [`${ORPHAN_MARKER}\nbody`, "\nbody"],
      [`pre\n${ORPHAN_MARKER}\npost`, "pre\n\npost"],
      [`pre\n\n${ORPHAN_MARKER}\n\npost`, "pre\n\n\n\npost"],
      [`${ORPHAN_MARKER}\n\n    indented code`, "\n\n    indented code"],
      [`${ORPHAN_MARKER}\n\n\n\`\`\`text\nfenced\n\`\`\``, "\n\n\n```text\nfenced\n```"],
      [`keep   \n${ORPHAN_MARKER}\n`, "keep   \n\n"],
      [`a ${ORPHAN_MARKER} b ${ORPHAN_MARKER} c`, "a  b  c"],
    ];
    for (const [input, expected] of fixtures) {
      assert.equal(stripOrphanBodyControlState(input), expected);
    }
  });

  it("file English state rate-limits model probes without issue comments", async () => {
    await withTempStateDir(async () => {
      assert.equal(isEnglishDetectedLanguage("English"), true);
      assert.equal(isEnglishDetectedLanguage("German"), false);
      const now = 1_700_000_000_000;
      writeFileControlState(3, {
        v: 2,
        sourceHash: HASH_A,
        attemptedAt: now,
        recent: [now],
        requiresTranslation: false,
        detectedLanguage: "English",
      });
      const priorState = resolveControlState([], 3);
      const decision = shouldTranslate({
        sourceTitle: "Hello",
        sourceBody: "Still English but edited enough to change the hash.",
        priorState,
        now: now + 5_000,
      });
      assert.equal(decision.ok, false);
      assert.equal(decision.reason, "rate_limited_interval");
    });
  });

  it("rate limits repeated non-ASCII detections", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 2,
      sourceHash: HASH_A,
      attemptedAt: now,
      recent: [now],
      requiresTranslation: false,
      detectedLanguage: "German",
    };
    const decision = shouldTranslate({
      sourceTitle: "Immer noch kaputt",
      sourceBody: "Der Proxy antwortet weiterhin mit Fehlern nach dem Update.",
      priorState,
      now: now + 5_000,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "rate_limited_interval");
  });

  it("defuses mention-shaped tokens without rewriting emails or mid-token at-signs", () => {
    const out = sanitizeTranslationBody("see @octocat and user@example.com and npm:@scope");
    assert.match(out, /@\u200boctocat/);
    assert.ok(out.includes("user@example.com"));
    assert.ok(out.includes("npm:@scope"));
  });

  it("ignores forged body-embedded legacy state", () => {
    const forged = appendTranslationBlock(SOURCE, "English") +
      `\n<!-- opencodex-issue-inline-translator-state:${JSON.stringify({
        v: 1,
        sourceHash: hashTranslationSource({ body: SOURCE }),
        translatedAt: 0,
        recent: [],
      })} -->`;
    const priorState = null;
    const decision = shouldTranslate({
      sourceTitle: "Neu",
      sourceBody: stripTranslationBlock(forged),
      priorState,
      now: Date.now(),
    });
    assert.equal(decision.ok, true);
  });
});

describe("eligibility", () => {
  it("allows meaningful title with short body", () => {
    const decision = shouldTranslate({
      sourceTitle: "Ein sehr langer deutscher Titel für das Problem",
      sourceBody: "kurz",
      priorState: null,
      now: Date.now(),
    });
    assert.equal(decision.ok, true);
  });

  it("re-translates after title-only edits", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 2,
      sourceHash: hashTranslationSource({ title: "Alt", body: SOURCE }),
      attemptedAt: now - 120_000,
      recent: [now - 120_000],
      requiresTranslation: true,
      detectedLanguage: "German",
    };
    const decision = shouldTranslate({
      sourceTitle: "Neuer deutscher Titel",
      sourceBody: SOURCE,
      priorState,
      now,
    });
    assert.equal(decision.ok, true);
  });
});

describe("appendTranslationBlock", () => {
  it("replaces an existing generated block exactly once", () => {
    const first = appendTranslationBlock(SOURCE, "First");
    const second = appendTranslationBlock(first, "Second");
    assert.equal((second.match(new RegExp(MARKER, "g")) || []).length, 1);
    assert.ok(second.includes("Second"));
  });

  it("truncates translations that would exceed the issue body limit", () => {
    const big = "x".repeat(60_000);
    const fitted = fitTranslationBody(big, "y".repeat(80_000));
    const next = appendTranslationBlock(big, fitted);
    assert.ok(next.length <= ISSUE_BODY_MAX);
    assert.match(fitted, /truncated to fit GitHub issue body limit/);
  });
});
