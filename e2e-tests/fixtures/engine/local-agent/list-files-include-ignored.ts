import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "List files including ignored .orianbuilder files",
  turns: [
    {
      text: "I'll list all files including the ignored .orianbuilder directory for you.",
      toolCalls: [
        {
          name: "list_files",
          args: {
            directory: ".orianbuilder",
            recursive: true,
            include_ignored: true,
          },
        },
      ],
    },
    {
      text: "Here are the ignored .orianbuilder files.",
    },
  ],
};
