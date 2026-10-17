/**
 * Sentinel-tag edges that no route fixture reaches.
 *
 * test/painted-once.test.ts drives whole turns, so it only exercises the tag
 * shapes a turn actually produces: one balanced span, cut across chunk
 * boundaries. The router and the stripper document four more behaviours that
 * every route depends on and no test pinned -- each of these was a mutant that
 * SURVIVED the full 535-test suite:
 *
 * - router flush releases a tail held back as a possible tag;
 * - a NESTED span keeps its inner tags, because extractFinal strips only the
 *   outermost pair and the streamed answer is reconciled against it;
 * - a stray closing tag outside any span is narration, not something to eat;
 * - stripper flush releases a tail held back as a possible tag.
 *
 * The nested case is asserted AGAINST extractFinal rather than against a
 * literal, because the requirement is agreement between the two: the router
 * streams the answer live and extractFinal is the arbiter at end of turn, so a
 * divergence re-sends the whole answer, which is the bug this family is for.
 *
 * Not pinned here: router flush leaves answerWhitespace set rather than
 * clearing it. That is unobservable -- it would take a feed() after flush(),
 * and no caller does that -- so a test for it would assert a state real
 * traffic cannot reach.
 */

import { describe, expect, it } from "vitest";
import { extractFinal, FINAL_CLOSE, FINAL_OPEN } from "../src/stream-adapter.js";
import { createSentinelRouter, createTagStripper } from "../src/transport-utils.js";

/** A router with both sinks captured as strings. */
function router() {
	const sinks = { narration: "", answer: "" };
	const r = createSentinelRouter(FINAL_OPEN, FINAL_CLOSE, {
		narration: (text) => {
			sinks.narration += text;
		},
		answer: (text) => {
			sinks.answer += text;
		},
	});
	return { ...r, feed: r.feed, flush: r.flush, sinks };
}

/** Feed in chunks of n characters, so every tag straddles a boundary somewhere. */
function feedInChunks(feed: (text: string) => void, text: string, n: number): void {
	for (let at = 0; at < text.length; at += n) feed(text.slice(at, at + n));
}

describe("createSentinelRouter: tag edges", () => {
	it("flush releases a tail held back as a possible tag", () => {
		const { feed, flush, sinks } = router();
		// "</pi_" is a prefix of the closing tag, so it is held back pending the
		// next chunk. The stream ends instead, and those bytes are still text.
		feed("notes </pi_");
		expect(sinks.narration, "the partial tag must be HELD, not narrated early").toBe("notes ");
		flush();
		expect(sinks.narration).toBe("notes </pi_");
		expect(sinks.answer).toBe("");
	});

	it("a nested span keeps its inner tags, matching extractFinal exactly", () => {
		const body = `${FINAL_OPEN}outer ${FINAL_OPEN}inner${FINAL_CLOSE} tail${FINAL_CLOSE}`;
		const { feed, flush, sinks } = router();
		feedInChunks(feed, body, 7);
		flush();
		const arbiter = extractFinal(body);
		// Not vacuous: the arbiter's answer does contain the inner pair.
		expect(arbiter.final).toContain(FINAL_OPEN);
		expect(sinks.answer).toBe(arbiter.final);
		expect(sinks.narration).toBe("");
	});

	it("a closing tag with nothing open is narrated, not eaten", () => {
		const { feed, flush, sinks } = router();
		feedInChunks(feed, `notes ${FINAL_CLOSE} more`, 5);
		flush();
		expect(sinks.narration).toBe(`notes ${FINAL_CLOSE} more`);
		expect(sinks.answer).toBe("");
	});
});

describe("createTagStripper: tag edges", () => {
	it("flush releases a tail held back as a possible tag", () => {
		let out = "";
		const stripper = createTagStripper([FINAL_OPEN, FINAL_CLOSE], (text) => {
			out += text;
		});
		stripper.push("answer </pi_");
		expect(out, "the partial tag must be HELD, not emitted early").toBe("answer");
		stripper.flush();
		expect(out).toBe("answer </pi_");
	});
});
