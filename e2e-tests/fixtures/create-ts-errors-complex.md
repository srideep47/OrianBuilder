Tests delete-rename-write order
<orianbuilder-delete path="src/main.tsx">
</orianbuilder-delete>
<orianbuilder-rename from="src/App.tsx" to="src/main.tsx">
</orianbuilder-rename>
<orianbuilder-write path="src/main.tsx" description="final main.tsx file.">
finalMainTsxFileWithError();
</orianbuilder-write>
EOM
