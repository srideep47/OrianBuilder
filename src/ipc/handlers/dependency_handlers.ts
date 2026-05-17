import { db } from "../../db";
import { messages, apps, chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getOrianBuilderAppPath } from "../../paths/paths";
import { executeAddDependency } from "../processors/executeAddDependency";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

const logger = log.scope("dependency_handlers");
const handle = createLoggedHandler(logger);

export function registerDependencyHandlers() {
  handle(
    "chat:add-dep",
    async (
      _event,
      { chatId, packages }: { chatId: number; packages: string[] },
    ): Promise<void> => {
      // Find the message from the database
      const foundMessages = await db.query.messages.findMany({
        where: eq(messages.chatId, chatId),
      });

      // Find the chat first
      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, chatId),
      });

      if (!chat) {
        throw new OrianBuilderError(
          `Chat ${chatId} not found`,
          OrianBuilderErrorKind.NotFound,
        );
      }

      // Get the app using the appId from the chat
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, chat.appId),
      });

      if (!app) {
        throw new OrianBuilderError(
          `App for chat ${chatId} not found`,
          OrianBuilderErrorKind.NotFound,
        );
      }

      const message = [...foundMessages]
        .reverse()
        .find((m) =>
          m.content.includes(
            `<orianbuilder-add-dependency packages="${packages.join(" ")}">`,
          ),
        );

      if (!message) {
        throw new Error(
          `Message with packages ${packages.join(", ")} not found`,
        );
      }

      await executeAddDependency({
        packages,
        message,
        appPath: getOrianBuilderAppPath(app.path),
      });
    },
  );
}
