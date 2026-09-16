// Redirect $HOME to a throwaway dir so tests that write agent profiles or
// pi agent frontmatter never touch the developer's real configuration.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-kiro-test-home-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
