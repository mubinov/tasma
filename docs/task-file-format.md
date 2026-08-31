# Task file format

This document defines the task file format. It is written for anyone who wants to
read or write task files with their own tools, in any language. It describes the
file content only. It does not describe where files are stored or how any program
is built.

A task file is a UTF-8 text file. Lines end with LF (`\n`). A reader must also
accept CRLF (`\r\n`); the CR is not part of the line content. A writer emits LF
for the text it produces. A writer that keeps a region it did not change keeps
the bytes of that region, so a CRLF file that is edited in one region holds both
endings.

The file carries no byte-order mark. A U+FEFF at the front of it is text like
any other, so the first line is not exactly `---` and a reader rejects the file.
A writer emits none, and a reader must not drop one.

## 1. Overview

A task file has three regions, in this order:

1. **Frontmatter** — a YAML mapping between two `---` lines. It holds the fields
   that describe the task.
2. **Body** — free markdown. One region. It describes the task itself.
3. **Comments** — zero or more. Each comment starts with a marker line and holds
   free markdown.

Every region is optional except the frontmatter. A file with frontmatter, an
empty body and no comments is valid.

The following file is the reference example. Every rule in this document applies
to it.

```markdown
---
id: PROJ-42
title: "Import the address book from a CSV file"
status: In Progress
workflow: delivery
step: build
priority: high
order: 4200
labels: [import]
parent: PROJ-30
created: "2024-05-06T09:15:00+02:00"
updated: "2024-05-08T16:30:00+02:00"
next_comment_id: 3
custom:
  workflow:
    attempts: 2
---

# Goal

This is the body: free markdown. It runs from the end of the
frontmatter to the first comment marker. The format defines no
sections inside it.

<!-- task:comment {id: 1, title: "Separator agreed", created: "2024-05-07T10:05:00+02:00", author: alex} -->

Body of comment 1: free markdown. It runs to the next marker.

<!-- task:comment
id: 2
title: "Rows with an empty column"
created: "2024-05-08T14:20:00+02:00"
updated: "2024-05-08T14:52:00+02:00"
author: alex
collapsed: true
custom:
  workflow: {attempt: 1, outcome: retry}
-->

Body of comment 2. The last comment runs to the end of the file.
```

## 2. Frontmatter

The file starts with a line that is exactly `---`. The frontmatter runs to the
next line that is exactly `---`. The text between the two lines is a YAML 1.2
mapping.

### Required keys

| Key | Type | Meaning |
|---|---|---|
| `id` | string | The task identifier, in the form `PROJ-N`. |
| `title` | string | The task title. |
| `status` | string | The workflow status of the task. |
| `created` | timestamp | When the task was created. |
| `updated` | timestamp | When the task was last changed. |
| `next_comment_id` | integer | The id the next new comment receives. |

### Optional keys

| Key | Type | Meaning |
|---|---|---|
| `workflow` | string | The workflow the task runs, for example `dev` or `design`. |
| `step` | string | The step of that workflow the task is on. |
| `priority` | string | The priority of the task. |
| `order` | integer | The manual sort position inside one status. |
| `labels` | list of strings | Free dimensions, for example `backend`. |
| `parent` | string | The id of a containing task. |
| `custom` | mapping | Data owned by other components. |

The values of `status`, `priority` and `labels` are not fixed by this format.
Each project declares its own. The *form* of a label is fixed, and only for a
writer: see *Values a writer rejects*. The values of `workflow` and `step` are
also not fixed: they are opaque strings that this format gives no meaning.
[Workflow file format](workflow-file-format.md) gives them one, and states the
form of a step name and when the two keys are checked.

The top-level `workflow` key and the `custom.workflow` mapping are different
things. The first names the workflow the task runs. The second holds data that a
workflow component owns. The example file contains both.

### Timestamps

A timestamp is an ISO 8601 date and time with a UTC offset, for example
`2024-05-06T09:15:00+02:00`. The offset is required. A trailing `Z` is a valid
offset. Seconds are required. A fraction of a second is allowed.

**A timestamp must be quoted.** Write `created: "2024-05-06T09:15:00+02:00"`, not
`created: 2024-05-06T09:15:00+02:00`. Some YAML libraries read an unquoted
timestamp as a native date value, and those values lose the offset when the file
is written back. Quoting keeps the value a string in every library.

### Unknown keys

A key this format does not define is legal. A writer must write it back
unchanged. The same rule applies to comments (`#`) inside the YAML, to key order,
and to the quoting style of each value.

An optional key written with no value, such as `step:`, is read as absent.

### Writing the frontmatter

The two `---` lines are the border of the region, and they are the only `---`
lines it holds. A third one closes the frontmatter early and turns the rest of it
into body text, so a writer must reject a frontmatter that would carry one.

### Mapping keys a reader rejects

`custom`, in the frontmatter and in a marker, is handed to other components,
which merge it into objects of their own. In several languages the keys
`__proto__`, `constructor` and `prototype` do not name data there: they address
the object model itself, and a merge that carries one changes the behavior of
the receiving object. A mapping that holds one of these keys, at any depth, is
rejected.

The rule covers every key of the region, not `custom` alone. A key this format
does not define is retained and written back, so it reaches a writer the same
way a defined key does.

### Values a reader rejects

A value in the frontmatter or in a marker is a scalar, a list, or a mapping. A
YAML tag that resolves to another shape, such as `!!omap` or `!!set`, is
rejected. Such a tag holds its entries in a form that a walk over a mapping does
not reach, so the rules stated above cannot be applied inside it.

### Limits a reader sets on YAML

YAML anchors and aliases let a small file expand into a very large value, and let
a value contain itself. A reader sets its own bound on how deep a value may nest
and on how many values one key expands to, and rejects a file that goes past the
bound instead of failing in an uncontrolled way. A value that contains itself is
rejected. This document fixes no number. The bound belongs to the reader.

A writer applies the same bound to a value it is given, because one value used in
several places is written out once per place.

### Values a writer rejects

A writer is given values by a caller as well as by a file. A caller states values
that no file can hold.

**The rule: the text a writer produces reads back as the values the writer was
given.** A writer that cannot write a value that way rejects the write. It names
the key that holds the value. If it cannot find that key, it names the region.

A writer does not write the value in another form to make it fit. A writer does
not report success when the text it wrote holds another value.

A file can hold a value that no text a writer generates reads back unchanged. A
reader still reads that file. A writer still writes that file back unchanged. A
writer rejects only a change to the region that holds the value.

A value is a string, a number, a boolean, or null. A value is also a list of
values, or a mapping of values. A programming language holds other kinds of
value: an integer too large for a number, a symbol, a function. This format has
no form for such a value. A writer rejects it and names the key.

A writer also rejects a list with a position that names no value. A caller states
such a position in two forms, depending on the language: a list that carries no
entry there at all, and an entry that names nothing. This format has no way to
write either: a writer that filled the position with a null value would change
the data it was given, and a reader would then refuse the file wherever a null
is not legal, as in `labels`. A writer rejects such a list and names the key.

A mapping key that names no value is a different case, and a writer accepts it.
It is read as absent, the same way a key written with no value is read as absent
in a file, and the rule holds at every level of a mapping. This is how a caller
clears a key. A writer writes no such key, and a region that carries the same
keys once these are dropped is a region the caller did not change, so the writer
keeps its bytes.

**The form of a label.** A label is one or more lowercase ASCII letters, digits
or dashes, and it carries a dash at neither end. A writer rejects a label of any
other form and names the key that holds it.

This is a rule of its own, not a case of the read-back rule above. A label such
as `Customer Request` reads back as the string the writer was given. It is
rejected because a label has a form, not because the text loses the value.

The rule binds a writer. A reader accepts a label of any form, so a file that a
hand edit or another tool wrote still loads.

**A writer rejects a label it is given, not one it carries over from the file it
is rewriting.** A change of the title of a task whose file holds the label
`Backend` is written, and the label stays as it stands. This is narrower than the
rule that *a writer rejects only a change to the region that holds the value*: a
regenerated frontmatter carries every key of the file through it, so the region
alone does not state which values the writer was given.

A writer carries a value over only while it holds the text the value was read
from. In a task copied in a way that drops that text, every value is a value the
writer is given, so every label in it is checked.

### Anchors and aliases a writer rejects

An anchor (`&name`) and the aliases that read it (`*name`) are one value written
once and used in several places. A writer that changes such a value has no
correct output: removing the anchored value leaves every alias unresolved, and
rewriting it in place changes what every alias reads, which is a change the
caller did not ask for.

An anchor sits on the value of a key, or on the name of the key itself. A writer
therefore rejects a change to a key whose value carries an anchor an alias reads,
and it rejects the removal of a key when either the value or the name carries
one. It names the key. A change to a key whose name carries the anchor is
written: the change replaces the value alone, so the name, the anchor on it and
every alias that reads the anchor stay as they stand.

A file that uses anchors is still read, is still written back unchanged, and
still accepts changes to its other keys. To make an anchored key changeable,
replace each alias with the value it reads and remove the anchor.

A writer creates no anchor of its own. One value that a caller places under two
keys is written out under each of them, so no key of the written file becomes
unchangeable through a rule the caller never asked for.

### Keys a writer cannot address

A writer changes one key at a time, and reaches a key by its name. Two YAML
constructs give a region a key that carries no name a writer can reach, although
a reader reports it like any other key. A writer that met one would remove
nothing where the caller removed a key, or write the key a second time where the
caller changed it, and report success either way.

- **A merge key** (`<<`) lends a mapping the keys of another mapping. YAML 1.2
  resolves it under its tag, written `!!merge <<:`; YAML 1.1, selected by a
  `%YAML 1.1` directive, resolves a plain `<<:` as well. A key the merge lends is
  reported as a key of the region, but it is not written in the region.
- **A key written as an alias** (`? *name`) resolves to the value the anchor
  holds. That value is the name a reader reports, and the region carries no key
  written under it.

A writer therefore rejects any change to a region that carries either construct.
Such a file is still read, and is still written back unchanged. To make it
changeable, write each key into the region under its own name and remove the
merge key or the alias.

## 3. Body

The body is free markdown. No program parses inside it. This format defines no
sections in it, such as acceptance criteria or notes. Any structure comes from
the markdown itself.

The body starts on the line after the closing `---` of the frontmatter. It runs
to the first comment marker, or to the end of the file when the task has no
comments.

The body is stored as it is written. Blank lines at its start and its end are
part of it.

## 4. Comments

A comment has a marker and a body.

### The marker

A marker is an HTML comment. It opens with exactly `<!-- task:comment`, with one
space after `<!--`. It holds one YAML mapping. It closes with `-->`.

The marker is an HTML comment for two reasons: a markdown preview hides it, and
it cannot be read as a heading or a horizontal rule.

There are two styles. Both are valid, and a reader must accept both.

**Flow style** puts the whole marker on one line. The YAML mapping is written in
flow style. Only spaces and tabs may follow the closing `-->` on that line.

```markdown
<!-- task:comment {id: 1, title: "Separator agreed", created: "2024-05-07T10:05:00+02:00"} -->
```

**Block style** puts the YAML mapping on the lines that follow. Nothing else
stands on the opening line. The marker closes with a line that is exactly `-->`.

```markdown
<!-- task:comment
id: 2
title: "Rows with an empty column"
custom:
  workflow: {attempt: 1, outcome: retry}
-->
```

A writer uses flow style when the mapping is flat, and block style when a value
of the mapping is itself a mapping or a list. A writer also uses block style when
the mapping carries YAML comments, because one line cannot hold them. The spaces
inside a flow mapping are not significant: `{id: 1}` and `{ id: 1 }` are the same
mapping.

**A marker carries no `-->` before the sequence that closes it.** That sequence
ends the HTML comment wherever it stands, and no YAML quoting can prevent it. The
rule covers values, keys and YAML comments alike. A writer must reject a marker
that would carry one and name the field. A reader must reject a marker that
already does, because the marker its writer meant and the marker a preview shows
are not the same.

**A marker key is not marker-shaped.** Block style writes a top-level key at
column 0, where a key that opens with `<!-- task:comment` starts a new comment
instead of naming a value. A writer must reject such a key in either style, and a
reader must reject a marker that already carries one. The rule covers top-level
keys only: every other part of a marker stands further right than column 0.

### Marker keys

| Key | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | integer | The comment id, unique in the file. |
| `title` | yes | string | The comment title. |
| `created` | yes | timestamp | When the comment was created. |
| `updated` | no | timestamp | When the comment was last edited. |
| `author` | no | string | Who wrote the comment. |
| `collapsed` | no | boolean | Print the title only, hide the body. |
| `custom` | no | mapping | Data owned by other components. |

Timestamps follow section 2, and so do the rules on the keys a mapping may not
hold, the values a reader rejects, the limits a reader sets, the values a writer
rejects, and the anchors and the unaddressable keys a writer rejects. A marker
carries its own YAML document, so a `%YAML`
directive inside one applies to that marker alone. Unknown marker keys are legal
and must be written back unchanged, like unknown frontmatter keys.

`id` is an integer, unique inside the task, and **never reused**. It is issued
from `next_comment_id`, which only increases. Deleting a comment leaves a
permanent gap in the numbering. Later comments quote earlier ids, so a reused id
would point at different text than before.

`updated` is written only when a comment is edited. There is no version history.

`collapsed` asks a renderer to print the title and hide the body. It is not
deletion and not truncation: the body stays in the file, so a text search still
finds it.

### The comment body

The body of a comment is free markdown. It starts on the line after the marker
closes. It runs to the next marker, or to the end of the file.

## 5. Marker recognition

A line is **marker-shaped** when its first characters, starting at column 0, are
`<!-- task:comment`.

A marker-shaped line is a real marker only when both of these hold:

1. It starts at column 0. One leading space is enough to make it text.
2. It is not inside a fenced code block.

This is what lets a task file carry the documentation of this format: a marker
example inside a fence is text, not a comment.

### Fenced code blocks

Fences follow the "Fenced code blocks" section of the CommonMark specification,
version 0.31.2. A reader of this format models this subset:

- A fence is three or more backticks, or three or more tildes. The two characters
  cannot be mixed.
- An opening fence may be indented by up to three spaces. A line indented by four
  or more spaces does not open a fence. Tabs do not count as indentation.
- A backtick fence whose info string contains a backtick is not a fence.
- A closing fence uses the same character as the opening fence, is at least as
  long as it, may be indented by up to three spaces, and may be followed only by
  spaces and tabs.
- An unclosed fence runs to the end of the file.

**Stated limit: container blocks are not modeled.** A fence inside a list item or
a block quote is indented, or prefixed by `>`, relative to column 0, so this
subset does not recognize it. This limit does not change marker recognition,
because a marker-shaped line starts at column 0, and a line at column 0 leaves
any list item or block quote it follows.

### An unclosed fence

A fence that opens and never closes runs to the end of the file, as CommonMark
specifies. Every marker-shaped line after it is text, not a marker. The file is
still valid. A reader accepts it and reports a warning that names the line of the
opening fence.

### Writing

Content is never rewritten to make it parse. A writer that would place a
marker-shaped line at column 0, outside a fence, inside the task body or inside a
comment body must reject the write and name the line. It must not indent, escape,
or otherwise change the text it was given. A marker key is covered by the same
rule, stated in section 4.

The same rule holds in the other direction. A body that opens a fence and never
closes it turns every marker after it into text, so a writer that would place a
marker after such a body must reject the write and name the line the fence opened
on. Without that rule the write would drop every comment that follows.

## 6. Malformed files

Two behaviors are defined for a file a reader cannot take at face value:

- **Reject.** The file does not load. The reader reports the file and the line.
- **Warn.** The file loads unchanged, and the reader reports the file and the
  line. Nothing is repaired.

The rule behind the split: reject when the structure of the file, or the
addressing of its comments, is ambiguous or unreadable; warn when the content is
unambiguous but the bookkeeping disagrees with it.

### A reader must reject

| Condition |
|---|
| The file does not start with `---`, or the frontmatter has no closing `---`. |
| The frontmatter is not valid YAML, or is not a mapping. |
| The YAML of the frontmatter or of a marker expands past the alias limit the reader sets, nests deeper than the reader allows, or holds a key that expands to more values than the reader allows. |
| A required frontmatter key is missing. |
| A frontmatter key holds a value of the wrong type. This includes `next_comment_id` that is not an integer, and `created` or `updated` that does not match the timestamp format. Optional keys are checked the same way when they are present. |
| A key of the frontmatter or of a marker holds a mapping with a `__proto__`, `constructor` or `prototype` key at any depth. |
| A key of the frontmatter or of a marker holds a value that contains itself. |
| A key of the frontmatter or of a marker holds a value that a YAML tag resolves to a shape other than a scalar, a list or a mapping, such as `!!omap` or `!!set`. |
| The YAML of a marker is invalid, or is not a mapping. |
| A block-style marker has no closing `-->` line before the next marker or the end of the file. |
| A marker carries `-->` before the sequence that closes it, in a value, a key or a YAML comment. |
| A top-level marker key opens with `<!-- task:comment`. |
| Text stands after the closing `-->` of a flow marker, or on the opening line of a block marker. |
| A required marker key is missing, or a marker key holds a value of the wrong type. |
| Two comments in the file carry the same `id`. |

### A reader must warn

| Condition |
|---|
| `next_comment_id` is less than or equal to the highest comment id in the file. The next id it would issue is already taken. |
| A fence opens and never closes. Marker-shaped lines after it are text. |

### A reader must accept in silence

| Condition |
|---|
| An unknown key, in the frontmatter or in a marker. A writer preserves it. |
| A `status`, `priority` or `label` value the project does not declare. These values are checked when a file is written, not when it is read. |
| A label whose form is not the one *Values a writer rejects* states, such as `Customer Request`. A reader loads it, and a writer that changes another key writes it back unchanged. |
| The same `order` value on two tasks. `order` is only meaningful inside one status. |
