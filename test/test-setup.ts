// Redirect $HOME to a throwaway dir so tests that write agent profiles or
// pi agent frontmatter never touch the developer's real configuration.
//
// setupFiles runs once per test FILE, so each file gets its own fake home. They
// are created INSIDE the run-scoped directory global-setup.ts makes, which is what
// actually removes them; see that file for why cleaning up from in here does not
// work. Falling back to tmpdir() keeps this correct (just untidy) if vitest is
// driven with a config that has no globalSetup.
//
// The live tests deliberately undo this redirect via withRealHome(), because
// kiro-cli keeps its IAM Identity Center token under
// $HOME/Library/Application Support/kiro-cli and reports "Not logged in" without
// it. They restore it afterwards, so the redirect still holds for everyone else.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_HOME_ROOT_ENV } from "./global-setup.js";

const TEST_HOME = mkdtempSync(join(process.env[TEST_HOME_ROOT_ENV] ?? tmpdir(), "pi-kiro-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

// Opt out of workflow-MCP discovery for the same reason $HOME is redirected: it
// reads the developer's real environment. discoverWorkflowMcpServers() walks up
// from process.cwd() looking for a GSD project, and pi-kiro's own repo root has
// a `.gsd` directory -- so it synthesizes a `gsdworkflow` server, startSession
// adds it to the set it waits on, and every acp-transport.test.ts script that
// answers initialize/session-new but never sends
// `_kiro.dev/mcp/server_initialized` for it hangs on the startup gate until the
// 5s test timeout. That is how 29 of those 43 tests came to fail: the suite was
// silently coupled to whether the checkout happened to be a GSD project.
//
// test/workflow-mcp.test.ts is unaffected -- it deletes this variable in its own
// beforeEach and drives discovery against explicit fixture directories.
process.env.PI_KIRO_WORKFLOW_MCP = "off";

// index.ts reads PI_KIRO_TRANSPORT directly ('src/index.ts:139') to choose
// makeStreamViaKiro vs makeStreamViaAcp, so a test process launched from a shell
// that exports PI_KIRO_TRANSPORT=acp -- for example, a GSD auto-mode run started
// with that variable set for the ACP transport -- silently swaps the wired
// implementation for every test in the file. test/index.test.ts's L0-04 mocks
// makeStreamViaKiro and asserts on its first call's arguments; under an
// inherited acp value that mock is never called, mock.calls is empty, and the
// destructure of calls[0] throws "Cannot read properties of undefined (reading
// 'getBridge')". Deterministic given the ambient env, not a flake -- same
// coupling class as PI_KIRO_WORKFLOW_MCP above, different variable.
//
// test/command-coverage-live.test.ts is unaffected -- it saves, sets, and
// restores this variable itself around the one test that needs acp.
delete process.env.PI_KIRO_TRANSPORT;

// KIRO_API_KEY switches authMethod() to "api-key" and changes readiness (a
// logged-out whoami no longer means not-ready). A developer shell that exports
// it would silently flip those tests; tests that need it set it themselves.
delete process.env.KIRO_API_KEY;
