# The two real specs the calibration set was built from

These are **not live specs.** They are here so a reviewer can check a
calibration case against the text it was frozen from, which was impossible
while they existed only in the maintainer's working copy (review item 21, third
bullet: `git log --all -- docs/specs/acp-print-mode-exit.md
docs/specs/dual-host-pi-gsd.md` was empty).

They are deliberately kept out of `docs/specs/`. A spec committed there is a
live spec: it enters the queue, it is subject to the gate, and it ships in the
npm tarball because `docs/` ships whole. Neither of these should be any of
those things. `acp-print-mode-exit.md` carries the three defects calibration
found in it, and `dual-host-pi-gsd.md` is labelled as failing every gate
(`expected.json`, case c2).

| File | Case | Relationship |
| --- | --- | --- |
| `dual-host-pi-gsd.md` | c2 | byte-identical to `cases/c2.md` |
| `acp-print-mode-exit.md` | c4 | the text c4 was frozen from, **before** eight calibration passes corrected it |

## Checking a case against its original

```
diff spec-review/calibration/originals/dual-host-pi-gsd.md \
     spec-review/calibration/cases/c2.md          # no output
diff spec-review/calibration/originals/acp-print-mode-exit.md \
     spec-review/calibration/cases/c4.md          # the eight passes' corrections
```

The second diff is the audit trail for "How the set was corrected" in
`../README.md`: every hunk in it should be accounted for by one of the eight
passes listed there.

## The one edit made on the way in

`dual-host-pi-gsd.md` had one absolute path from the maintainer's home
directory inside a fenced error transcript. It is rewritten `~/.gsd/...`, which
is how the same path is already written in the prose two bullets below it. The
same edit was made to `cases/c2.md`, so the two stay byte-identical.

| | sha256 |
| --- | --- |
| as it stood in the working copy | `7733ab1733f499e660576201b6d393cf0966691edac8f665201951992488ce5c` |
| as committed here, and as `cases/c2.md` | `618244367a07c44aa81c60ffb0d6b158c913b83c04337cc513bf5bfc3a80fb81` |
| `acp-print-mode-exit.md`, unedited | `645c686c6fa845a80664de9cf6416efe5ecd240578b33395918bdff16c1d03b5` |

Nothing else was changed in either file. `acp-print-mode-exit.md` needed no
edit; it contains no path outside the repository.
