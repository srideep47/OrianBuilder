# Custom Chat Message Indicators

The `<orianbuilder-status>` tag in chat messages renders as a collapsible status indicator box. Use it for system messages like compaction notifications:

```
<orianbuilder-status title="My Title" state="finished">
Content here
</orianbuilder-status>
```

Valid states: `"finished"`, `"in-progress"`, `"aborted"`

- Renderer unit tests that import `OrianBuilderMarkdownParser` should mock `../preview_panel/FileEditor`; otherwise the `OrianBuilderWrite` import initializes Monaco and Happy DOM may try to fetch `cdn.jsdelivr.net`, causing offline `ENOTFOUND` failures.
