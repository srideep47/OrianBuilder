import { ipcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import type { IpcContract } from "../contracts/core";
import { sendTelemetryException } from "../utils/telemetry";

// =============================================================================
// Main-process handler registry
// =============================================================================

/**
 * Every typed handler, keyed by channel, callable from inside the main process.
 *
 * `ipcMain.handle` registers a handler that only a renderer can reach — there
 * is no main-side counterpart to `invoke`. Marta runs in main and has to call
 * the same endpoints the UI calls, so the registration point records the
 * handler as well as installing it. The alternative was a renderer loopback
 * (ask the window to make the call and post the result back), which needs a
 * live window, doubles the latency, and silently fails while the app is
 * starting or the window is closed.
 *
 * This is a lookup table, not a permission model. Marta's permission model is
 * `ACTION_REGISTRY`; see `src/main/marta/invoke_action.ts`, which is the only
 * thing that should use this and which checks the grant before it does.
 */
export interface RegisteredHandler {
  contract: IpcContract<string, z.ZodType, z.ZodType>;
  handler: (
    event: IpcMainInvokeEvent,
    input: unknown,
  ) => Promise<unknown> | unknown;
}

const mainInvokableHandlers = new Map<string, RegisteredHandler>();

/** Look up a handler by IPC channel for in-process invocation. */
export function getRegisteredHandler(
  channel: string,
): RegisteredHandler | undefined {
  return mainInvokableHandlers.get(channel);
}

/** Channels with a recorded handler. Diagnostics only. */
export function registeredHandlerChannels(): string[] {
  return [...mainInvokableHandlers.keys()].sort();
}

function recordHandler(
  contract: IpcContract<string, z.ZodType, z.ZodType>,
  handler: RegisteredHandler["handler"],
): void {
  mainInvokableHandlers.set(contract.channel, { contract, handler });
}

/**
 * Creates a typed IPC handler from a contract.
 * Provides runtime validation of inputs and type-safe handler implementation.
 *
 * @example
 * createTypedHandler(appContracts.createApp, async (_event, params) => {
 *   // params is typed as z.infer<CreateAppParamsSchema>
 *   // return type is enforced as z.infer<CreateAppResultSchema>
 *   const [app] = await db.insert(apps).values({ name: params.name }).returning();
 *   return { app, chatId: chat.id };
 * });
 */
export function createTypedHandler<
  TChannel extends string,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  contract: IpcContract<TChannel, TInput, TOutput>,
  handler: (
    event: IpcMainInvokeEvent,
    input: z.infer<TInput>,
  ) => Promise<z.infer<TOutput>>,
): void {
  recordHandler(
    contract as IpcContract<string, z.ZodType, z.ZodType>,
    handler as RegisteredHandler["handler"],
  );
  ipcMain.handle(
    contract.channel,
    async (event: IpcMainInvokeEvent, rawInput: unknown) => {
      // Runtime validation of input
      const parsed = contract.input.safeParse(rawInput);
      if (!parsed.success) {
        const errorMessage = parsed.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; ");
        throw new OrianBuilderError(
          `[${contract.channel}] Invalid input: ${errorMessage}`,
          OrianBuilderErrorKind.Validation,
        );
      }

      let result: z.infer<TOutput>;
      try {
        result = await handler(event, parsed.data);
      } catch (err) {
        sendTelemetryException(err, { ipc_channel: contract.channel });
        throw err;
      }

      // Validate output in development mode only (catches handler bugs without prod overhead)
      if (process.env.NODE_ENV === "development") {
        const outputParsed = contract.output.safeParse(result);
        if (!outputParsed.success) {
          const errorMessage = outputParsed.error.issues
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join("; ");
          console.error(
            `[${contract.channel}] Output validation warning: ${errorMessage}`,
          );
        }
      }

      return result;
    },
  );
}

/**
 * Creates a typed IPC handler with logging support.
 * Combines typed handling with the existing logging infrastructure.
 *
 * @example
 * const handle = createLoggedTypedHandler(logger);
 * handle(appContracts.createApp, async (_event, params) => {
 *   return { app, chatId: chat.id };
 * });
 */
export function createLoggedTypedHandler(logger: {
  info: (msg: string) => void;
  error: (msg: string, err?: any) => void;
}) {
  return function <
    TChannel extends string,
    TInput extends z.ZodType,
    TOutput extends z.ZodType,
  >(
    contract: IpcContract<TChannel, TInput, TOutput>,
    handler: (
      event: IpcMainInvokeEvent,
      input: z.infer<TInput>,
    ) => Promise<z.infer<TOutput>>,
  ): void {
    recordHandler(
      contract as IpcContract<string, z.ZodType, z.ZodType>,
      handler as RegisteredHandler["handler"],
    );
    ipcMain.handle(
      contract.channel,
      async (event: IpcMainInvokeEvent, rawInput: unknown) => {
        // Runtime validation of input
        const parsed = contract.input.safeParse(rawInput);
        if (!parsed.success) {
          const errorMessage = parsed.error.issues
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join("; ");
          const error = new OrianBuilderError(
            `[${contract.channel}] Invalid input: ${errorMessage}`,
            OrianBuilderErrorKind.Validation,
          );
          logger.error(`[${contract.channel}] Invalid input`, error);
          throw error;
        }

        try {
          logger.info(`[${contract.channel}] Handling request`);
          const result = await handler(event, parsed.data);

          // Validate output in development mode only
          if (process.env.NODE_ENV === "development") {
            const outputParsed = contract.output.safeParse(result);
            if (!outputParsed.success) {
              const errorMessage = outputParsed.error.issues
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join("; ");
              console.error(
                `[${contract.channel}] Output validation warning: ${errorMessage}`,
              );
            }
          }

          return result;
        } catch (err) {
          logger.error(`[${contract.channel}] Handler error`, err);
          sendTelemetryException(err, { ipc_channel: contract.channel });
          throw err;
        }
      },
    );
  };
}

/**
 * Helper to register multiple typed handlers at once.
 *
 * @example
 * registerTypedHandlers({
 *   [appContracts.createApp]: async (_event, params) => { ... },
 *   [appContracts.deleteApp]: async (_event, params) => { ... },
 * });
 */
export function registerTypedHandlers<
  T extends Record<string, IpcContract<string, z.ZodType, z.ZodType>>,
>(
  handlers: {
    [K in keyof T]: (
      event: IpcMainInvokeEvent,
      input: z.infer<T[K]["input"]>,
    ) => Promise<z.infer<T[K]["output"]>>;
  },
  contracts: T,
): void {
  for (const [key, contract] of Object.entries(contracts)) {
    const handler = handlers[key as keyof typeof handlers];
    if (handler) {
      // @ts-expect-error zod v4 type inference is not working correctly
      createTypedHandler(contract, handler);
    }
  }
}
