import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetSessions,
	advanceSession,
	dropSession,
	hashMessages,
	type ListSessionsFn,
	planTurn,
	recordFreshSession,
	snapshotSessions,
} from "./session-manager.js";

const CWD = "/work/proj";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;
const fakeList =
	(ids: string[]): ListSessionsFn =>
	async () =>
		ids.map((sessionId) => ({ sessionId }));

describe("session-manager", () => {
	beforeEach(() => {
		_resetSessions();
		delete process.env.PI_KIRO_RESUME;
	});

	it("hashes deterministically and ignores volatile thinking blocks", () => {
		const withThinkingA = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "one" },
				{ type: "text", text: "hi" },
			],
			timestamp: 0,
		} as unknown as Message;
		const withThinkingB = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "TOTALLY DIFFERENT" },
				{ type: "text", text: "hi" },
			],
			timestamp: 0,
		} as unknown as Message;
		expect(hashMessages([withThinkingA])).toBe(hashMessages([withThinkingB]));
		expect(hashMessages([user("a")])).not.toBe(hashMessages([user("b")]));
	});

	it("plans fresh when no session matches", () => {
		expect(planTurn(CWD, [user("hello")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("records a fresh session then resumes on pure append", async () => {
		const pre = await snapshotSessions(CWD, fakeList([]));
		const id = await recordFreshSession(CWD, [user("t1")], pre, fakeList(["sess-A"]));
		expect(id).toBe("sess-A");
		expect(planTurn(CWD, [user("t1"), assistant("r1"), user("t2")])).toMatchObject({
			mode: "resume",
			resumeId: "sess-A",
			deltaStart: 1,
		});
	});

	it("records nothing when capture is ambiguous (concurrent race)", async () => {
		const pre = await snapshotSessions(CWD, fakeList(["old"]));
		const id = await recordFreshSession(CWD, [user("t1")], pre, fakeList(["old", "new1", "new2"]));
		expect(id).toBeUndefined();
		expect(planTurn(CWD, [user("t1"), user("t2")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("records nothing when no new session appeared (not persisted / list failed)", async () => {
		const pre = await snapshotSessions(CWD, fakeList(["old"]));
		expect(await recordFreshSession(CWD, [user("t1")], pre, fakeList(["old"]))).toBeUndefined();
	});

	it("resets to fresh when the prefix diverges (compaction/edit)", async () => {
		const pre = await snapshotSessions(CWD, fakeList([]));
		await recordFreshSession(CWD, [user("t1"), user("t2")], pre, fakeList(["sess-A"]));
		expect(planTurn(CWD, [user("SUMMARY"), user("t3")])).toEqual({ mode: "fresh", deltaStart: 0 });
		// also diverges when the context is shorter than what was sent (truncation)
		expect(planTurn(CWD, [user("t1")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("plans fresh when the only new content is an assistant echo", async () => {
		const pre = await snapshotSessions(CWD, fakeList([]));
		await recordFreshSession(CWD, [user("t1")], pre, fakeList(["sess-A"]));
		expect(planTurn(CWD, [user("t1"), assistant("r1")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("advances the resume anchor forward", async () => {
		const pre = await snapshotSessions(CWD, fakeList([]));
		await recordFreshSession(CWD, [user("t1")], pre, fakeList(["sess-A"]));
		const msgs2 = [user("t1"), assistant("r1"), user("t2")];
		advanceSession("sess-A", msgs2);
		expect(planTurn(CWD, [...msgs2, assistant("r2"), user("t3")])).toMatchObject({
			mode: "resume",
			resumeId: "sess-A",
			deltaStart: 3,
		});
	});

	it("drops a session on request", async () => {
		const pre = await snapshotSessions(CWD, fakeList([]));
		await recordFreshSession(CWD, [user("t1")], pre, fakeList(["sess-A"]));
		dropSession("sess-A");
		expect(planTurn(CWD, [user("t1"), user("t2")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("never resumes across a different cwd", async () => {
		const pre = await snapshotSessions(CWD, fakeList([]));
		await recordFreshSession(CWD, [user("t1")], pre, fakeList(["sess-A"]));
		expect(planTurn("/other/cwd", [user("t1"), user("t2")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});

	it("honors PI_KIRO_RESUME=off (always fresh, never records)", async () => {
		process.env.PI_KIRO_RESUME = "off";
		const pre = await snapshotSessions(CWD, fakeList([]));
		expect(await recordFreshSession(CWD, [user("t1")], pre, fakeList(["sess-A"]))).toBeUndefined();
		expect(planTurn(CWD, [user("t1"), user("t2")])).toEqual({ mode: "fresh", deltaStart: 0 });
	});
});
