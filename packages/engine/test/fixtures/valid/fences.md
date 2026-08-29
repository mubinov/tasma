---
id: PROJ-4
title: "Fence handling"
status: In Progress
created: "2026-03-01T00:00:00+00:00"
updated: "2026-03-01T00:00:00+00:00"
next_comment_id: 2
---

A tilde fence hides a marker-shaped line:

~~~
<!-- task:comment {id: 90, title: "text", created: "2026-03-01T00:00:00+00:00"} -->
~~~

A tilde info string may contain backticks:

~~~ ```
<!-- task:comment {id: 91, title: "text", created: "2026-03-01T00:00:00+00:00"} -->
~~~

A backtick fence may be closed by a longer fence:

```text
<!-- task:comment {id: 92, title: "text", created: "2026-03-01T00:00:00+00:00"} -->
`````

An opening fence may be indented by up to three spaces:

   ```
<!-- task:comment {id: 93, title: "text", created: "2026-03-01T00:00:00+00:00"} -->
   ```

Four spaces do not open a fence, so the next marker is a real one:

    ```

<!-- task:comment {id: 1, title: "Fences work inside a comment body", created: "2026-03-01T01:00:00+00:00"} -->

The body of this comment holds a fence of its own:

```
<!-- task:comment {id: 94, title: "text", created: "2026-03-01T00:00:00+00:00"} -->
```

The comment runs to the end of the file.
