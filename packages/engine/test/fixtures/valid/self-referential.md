---
id: PROJ-5
title: "The format documents itself"
status: In Progress
created: "2026-04-01T00:00:00+03:00"
updated: "2026-04-01T00:00:00+03:00"
next_comment_id: 2
---

# Marker examples

A flow marker looks like this:

```markdown
<!-- task:comment {id: 1, title: "Example", created: "2026-04-01T00:00:00+03:00"} -->
```

A block marker looks like this:

```markdown
<!-- task:comment
id: 2
title: "Example"
created: "2026-04-01T00:00:00+03:00"
-->
```

Neither example above is a comment. Both are text inside a fence.

<!-- task:comment {id: 1, title: "Only this marker is real", created: "2026-04-01T00:10:00+03:00", author: alex} -->

The task has exactly one comment.
