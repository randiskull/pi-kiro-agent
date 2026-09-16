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
